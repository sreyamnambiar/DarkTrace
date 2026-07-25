import { useEffect, useState } from "react";
import { IconBarChart, IconDownload, IconFilter } from "./icons";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

interface ReportItem {
  id: string | number;
  name: string;
  date: string;
  type: string;
  size: string;
  raw?: any;
}

/* ──────────────────── tiny inline PDF builder (no deps) ──────────────────── */

function buildPdfBytes(lines: string[], title: string): Uint8Array {
  // Build a minimal but valid single-page PDF with text content
  const pageW = 595;
  const pageH = 842;
  const margin = 50;
  const fontSize = 11;
  const titleSize = 18;
  const lineHeight = 15;

  // Escape special PDF chars
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  // Build the content stream
  let stream = "";
  // title
  stream += `BT /F1 ${titleSize} Tf ${margin} ${pageH - margin - titleSize} Td (${esc(title)}) Tj ET\n`;
  // separator line
  const lineY = pageH - margin - titleSize - 10;
  stream += `${margin} ${lineY} m ${pageW - margin} ${lineY} l S\n`;

  let y = lineY - lineHeight - 5;
  for (const line of lines) {
    if (y < margin) break; // stop if we run out of page
    stream += `BT /F1 ${fontSize} Tf ${margin} ${y} Td (${esc(line)}) Tj ET\n`;
    y -= lineHeight;
  }

  // footer
  stream += `BT /F1 8 Tf ${margin} 30 Td (DarkTrace Cybersecurity Report - Generated ${new Date().toLocaleString()}) Tj ET\n`;

  const streamBytes = new TextEncoder().encode(stream);

  // Assemble PDF objects
  const objs: string[] = [];

  // obj 1 - catalog
  objs.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj");
  // obj 2 - pages
  objs.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj");
  // obj 3 - page
  objs.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj`
  );
  // obj 4 - content stream
  objs.push(
    `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${stream}endstream\nendobj`
  );
  // obj 5 - font
  objs.push(
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj"
  );

  // Build final PDF
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objs) {
    offsets.push(pdf.length);
    pdf += obj + "\n";
  }
  const xrefOffset = pdf.length;
  pdf += "xref\n";
  pdf += `0 ${objs.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += "trailer\n";
  pdf += `<< /Size ${objs.length + 1} /Root 1 0 R >>\n`;
  pdf += "startxref\n";
  pdf += `${xrefOffset}\n`;
  pdf += "%%EOF\n";

  return new TextEncoder().encode(pdf);
}

function generatePdfContent(reportName: string, rawData?: any): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Report: ${reportName}`);
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push("");

  const input = rawData?.input || "N/A";
  const kind = rawData?.kind || "url";
  lines.push(`Scan Type: ${kind.toUpperCase()}`);
  lines.push(`Target: ${input}`);
  lines.push("");

  const riskScore = rawData?.riskScore ?? "N/A";
  const classification = rawData?.classification || "Unknown";
  const riskLevel = rawData?.riskLevel || "Unknown";
  const mlScore = rawData?.mlScore ?? "N/A";
  const heuristicScore = rawData?.heuristicScore ?? "N/A";

  lines.push("--- RISK ASSESSMENT ---");
  lines.push(`Classification: ${classification}`);
  lines.push(`Risk Level: ${riskLevel}`);
  lines.push(`Overall Risk Score: ${riskScore} / 100`);
  lines.push(`ML Model Score: ${mlScore} / 100`);
  lines.push(`Heuristic Score: ${heuristicScore} / 100`);
  lines.push("");

  if (rawData?.explanation?.length) {
    lines.push("--- AI ANALYSIS ---");
    rawData.explanation.forEach((e: string) => lines.push(`  - ${e}`));
    lines.push("");
  }

  if (rawData?.heuristicResults?.length) {
    lines.push("--- HEURISTIC CHECKS ---");
    rawData.heuristicResults.forEach((h: any) => {
      lines.push(`  [${h.status?.toUpperCase()}] ${h.name} (+${h.riskContribution || 0})`);
      if (h.explanation) lines.push(`     ${h.explanation}`);
    });
    lines.push("");
  }

  if (rawData?.reasons?.length) {
    lines.push("--- RISK FACTORS ---");
    rawData.reasons.forEach((r: string) => lines.push(`  * ${r}`));
    lines.push("");
  }

  lines.push("--- RECOMMENDATIONS ---");
  lines.push("  1. Avoid entering credentials on untrusted portals.");
  lines.push("  2. Verify domain WHOIS records for ownership.");
  lines.push("  3. Use DarkTrace browser extension for domain blocking.");
  lines.push("");
  lines.push("DarkTrace Advanced Threat Intelligence - Confidential");

  return lines;
}

/* ──────────────────── component ──────────────────── */

export default function Reports() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string | number;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* fetch reports from backend */
  useEffect(() => {
    let cancelled = false;
    async function fetchReports() {
      try {
        const res = await fetch(`${API_BASE}/api/dashboard/history?limit=100`);
        if (!res.ok) throw new Error("Failed to fetch reports");
        const data = await res.json();
        const mapped: ReportItem[] = (data.results || []).map((r: any) => {
          const type = r.kind === "url" ? "PDF" : "CSV";
          const size = `${(1.2 + (r.riskScore || 0) * 0.05).toFixed(1)} MB`;
          const date = r.processedAt
            ? new Date(r.processedAt).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0];
          const displayName =
            r.kind === "url"
              ? `URL Scan Report - ${r.input}`
              : `Email Scan Report - ${r.emailParsedData?.subject || r.input}`;
          return { id: r.id, name: displayName, date, type, size, raw: r };
        });
        if (!cancelled) setReports(mapped);
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Error fetching reports.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchReports();
    return () => { cancelled = true; };
  }, []);

  /* generate ad-hoc report */
  const handleGenerate = () => {
    setIsGenerating(true);
    setTimeout(() => {
      const mockRaw = {
        input: "https://darktrace-adhoc-check.io/dashboard/login",
        kind: "url",
        processedAt: new Date().toISOString(),
        riskScore: 82,
        riskLevel: "Critical",
        classification: "Phishing",
        mlScore: 88,
        heuristicScore: 76,
        explanation: [
          "The scanned page contains input fields mimicking corporate auth portals.",
          "ML classifier detected anomalous structural distributions.",
          "WHOIS database records show the hosting domain was registered very recently.",
        ],
        heuristicResults: [
          { name: "Domain Creation Check", status: "fail", riskContribution: 40, explanation: "Target domain age is under 30 days." },
          { name: "Branding Spoof Check", status: "fail", riskContribution: 36, explanation: "Keyword mimicking registered trademarks." },
          { name: "SSL Certificate Validation", status: "pass", riskContribution: 0, explanation: "SSL certificate is validly signed." },
        ],
        reasons: [
          "Host name simulates corporate identity.",
          "Extreme risk probability returned by deep neural-net scan.",
        ],
      };
      setReports((prev) => [
        {
          id: Date.now(),
          name: "Ad-hoc Security Scan Report",
          date: new Date().toISOString().split("T")[0],
          type: "PDF",
          size: "1.1 MB",
          raw: mockRaw,
        },
        ...prev,
      ]);
      setIsGenerating(false);
    }, 1500);
  };

  /* download handler */
  const handleDownload = (name: string, type: string, rawData?: any) => {
    const safeName = name.replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_");

    if (type === "PDF") {
      const lines = generatePdfContent(name, rawData);
      const bytes = buildPdfBytes(lines, "DARKTRACE CYBERSECURITY REPORT");
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      // CSV
      const headers = ["Metric", "Value"];
      const rows = [
        ["Report Name", name],
        ["Timestamp", rawData?.processedAt || new Date().toLocaleString()],
        ["Type", rawData?.kind || "url"],
        ["Target", rawData?.input || ""],
        ["Risk Score", String(rawData?.riskScore ?? "N/A")],
        ["Classification", rawData?.classification || ""],
        ["Risk Level", rawData?.riskLevel || ""],
        ["ML Score", String(rawData?.mlScore ?? "N/A")],
        ["Heuristic Score", String(rawData?.heuristicScore ?? "N/A")],
      ];
      const csvStr =
        [headers, ...rows]
          .map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(","))
          .join("\n");
      const blob = new Blob([csvStr], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  /* delete handler */
  const handleDelete = async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/api/history/${deleteConfirm.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      setReports((prev) => prev.filter((r) => r.id !== deleteConfirm.id));
    } catch (e: any) {
      alert(e.message || "Failed to delete report.");
    } finally {
      setDeleting(false);
      setDeleteConfirm(null);
    }
  };

  /* ──────────────────── render ──────────────────── */
  return (
    <div className="page-wrapper" style={{ maxWidth: "1000px", margin: "0 auto" }}>
      <div className="table-card">
        <div className="table-card-header">
          <div>
            <p className="table-card-title">Security Reports</p>
            <p
              style={{
                fontSize: "0.8rem",
                color: "var(--text-secondary)",
                marginTop: "4px",
              }}
            >
              Generate and export security metrics for compliance and analysis.
            </p>
          </div>
          <div className="table-card-actions">
            <button className="table-filter-btn">
              <IconFilter /> Filter by Date
            </button>
            <button
              className="export-btn"
              onClick={handleGenerate}
              disabled={isGenerating}
            >
              <IconBarChart />{" "}
              {isGenerating ? "Generating..." : "Generate New Report"}
            </button>
          </div>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Report Name</th>
              <th>Format</th>
              <th>Size</th>
              <th>Generated Date</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    textAlign: "center",
                    padding: "2rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  <div
                    className="loading-spinner"
                    style={{
                      margin: "0 auto 1rem",
                      width: "30px",
                      height: "30px",
                    }}
                  />
                  Loading reports...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    textAlign: "center",
                    padding: "2rem",
                    color: "var(--danger)",
                  }}
                >
                  {error}
                </td>
              </tr>
            ) : reports.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    textAlign: "center",
                    padding: "2rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  No reports generated yet.
                </td>
              </tr>
            ) : (
              reports.map((report) => (
                <tr key={report.id}>
                  <td style={{ fontWeight: 500, color: "var(--text)" }}>
                    {report.name}
                  </td>
                  <td>
                    <span
                      className={`status-badge ${
                        report.type === "PDF" ? "critical" : "safe"
                      }`}
                    >
                      {report.type}
                    </span>
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>
                    {report.size}
                  </td>
                  <td className="table-date-cell">{report.date}</td>
                  <td style={{ textAlign: "right" }}>
                    <div
                      style={{
                        display: "inline-flex",
                        gap: "0.5rem",
                        alignItems: "center",
                      }}
                    >
                      <button
                        className="export-btn"
                        style={{ fontSize: "0.78rem", padding: "0.35rem 0.75rem" }}
                        onClick={() =>
                          handleDownload(report.name, report.type, report.raw)
                        }
                      >
                        <IconDownload /> Download
                      </button>
                      <button
                        className="table-filter-btn"
                        style={{
                          fontSize: "0.78rem",
                          padding: "0.35rem 0.75rem",
                          color: "var(--danger, #dc2626)",
                          borderColor: "var(--danger, #dc2626)",
                          background: "transparent",
                        }}
                        onClick={() =>
                          setDeleteConfirm({
                            id: report.id,
                            name: report.name,
                          })
                        }
                      >
                        🗑 Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Delete Confirmation Modal ── */}
      {deleteConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => !deleting && setDeleteConfirm(null)}
        >
          <div
            style={{
              background: "var(--card-bg, #1e293b)",
              border: "1px solid var(--border, #334155)",
              borderRadius: "12px",
              padding: "2rem",
              maxWidth: "420px",
              width: "90%",
              boxShadow: "0 25px 60px rgba(0,0,0,0.3)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p
              style={{
                fontWeight: 700,
                fontSize: "1.1rem",
                color: "var(--text, #f1f5f9)",
                marginBottom: "0.5rem",
              }}
            >
              Delete Report?
            </p>
            <p
              style={{
                fontSize: "0.875rem",
                color: "var(--text-secondary, #94a3b8)",
                marginBottom: "1.5rem",
                lineHeight: 1.6,
              }}
            >
              <strong style={{ color: "var(--text, #f1f5f9)" }}>
                {deleteConfirm.name}
              </strong>{" "}
              will be permanently removed. This action cannot be undone.
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                className="table-filter-btn"
                onClick={() => setDeleteConfirm(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="export-btn"
                style={{
                  background: "var(--danger, #dc2626)",
                  borderColor: "var(--danger, #dc2626)",
                  color: "#fff",
                }}
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Yes, Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
