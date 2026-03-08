/**
 * Digest Dashboard — serves the email digest history at GET /digest
 *
 * The email-digest skill writes JSON files to ~/.openclaw/digests/*.json
 * This module reads those files and serves them as a lightweight web dashboard.
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

const DIGESTS_DIR = path.join(os.homedir(), ".openclaw", "digests");
const DIGEST_PATH = "/digest";
const DIGEST_DATA_PATH = "/digest/data";
const MAX_DIGESTS = 48; // keep last 48 hours (hourly runs)

type DigestEntry = {
  timestamp: string;
  windowStart?: string;
  windowEnd?: string;
  counts?: {
    total: number;
    leads: number;
    replies: number;
    followups: number;
    internal: number;
    noise: number;
  };
  digest: string;
};

function readDigests(): DigestEntry[] {
  if (!fs.existsSync(DIGESTS_DIR)) {
    return [];
  }
  const files = fs
    .readdirSync(DIGESTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
    .toReversed()
    .slice(0, MAX_DIGESTS);

  const entries: DigestEntry[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(DIGESTS_DIR, file), "utf8");
      const parsed = JSON.parse(raw) as DigestEntry;
      if (parsed.digest && parsed.timestamp) {
        entries.push(parsed);
      }
    } catch {
      // skip malformed files
    }
  }
  return entries;
}

function renderHtml(digests: DigestEntry[]): string {
  const hasDigests = digests.length > 0;
  const latestDigest = hasDigests ? digests[0] : null;

  const digestCards = digests
    .map((d) => {
      const counts = d.counts;
      const countBadges = counts
        ? [
            counts.leads > 0 ? `<span class="badge lead">${counts.leads} leads</span>` : "",
            counts.followups > 0
              ? `<span class="badge followup">${counts.followups} follow-ups</span>`
              : "",
            counts.replies > 0 ? `<span class="badge reply">${counts.replies} replies</span>` : "",
            `<span class="badge total">${counts.total} total</span>`,
          ]
            .filter(Boolean)
            .join(" ")
        : "";

      // Escape HTML in digest text and convert markdown-ish formatting
      const escapedDigest = d.digest
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      const ts = new Date(d.timestamp);
      const timeLabel = isNaN(ts.getTime()) ? d.timestamp : ts.toLocaleString();

      return `
      <div class="card">
        <div class="card-header">
          <span class="time">${timeLabel}</span>
          <div class="badges">${countBadges}</div>
        </div>
        <pre class="digest-text">${escapedDigest}</pre>
      </div>`;
    })
    .join("\n");

  const lastUpdated = latestDigest
    ? `Last updated: ${new Date(latestDigest.timestamp).toLocaleString()}`
    : "No digests yet";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="300">
  <title>Email Intelligence Digest</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      padding: 24px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
      padding-bottom: 16px;
      border-bottom: 1px solid #2d3748;
    }
    h1 { font-size: 1.5rem; font-weight: 700; }
    h1 span { margin-right: 8px; }
    .meta { font-size: 0.8rem; color: #718096; }
    .empty {
      text-align: center;
      padding: 64px 24px;
      color: #718096;
    }
    .empty p { margin-top: 12px; font-size: 0.9rem; }
    .card {
      background: #1a202c;
      border: 1px solid #2d3748;
      border-radius: 8px;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: #171d29;
      border-bottom: 1px solid #2d3748;
      flex-wrap: wrap;
      gap: 8px;
    }
    .time { font-size: 0.85rem; color: #a0aec0; font-weight: 500; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge.lead { background: #2f855a; color: #9ae6b4; }
    .badge.followup { background: #744210; color: #fbd38d; }
    .badge.reply { background: #2b4c7e; color: #90cdf4; }
    .badge.total { background: #2d3748; color: #a0aec0; }
    .digest-text {
      padding: 16px;
      font-family: 'SF Mono', 'Fira Code', 'Fira Mono', monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      color: #cbd5e0;
    }
    @media (max-width: 640px) {
      body { padding: 12px; }
      h1 { font-size: 1.2rem; }
    }
  </style>
</head>
<body>
  <header>
    <h1><span>📬</span>Email Intelligence Digest</h1>
    <span class="meta">${lastUpdated} · auto-refreshes every 5 min</span>
  </header>
  ${
    hasDigests
      ? digestCards
      : `<div class="empty">
      <div style="font-size:3rem">📭</div>
      <p>No digests yet. The hourly email digest will appear here.</p>
      <p style="margin-top:8px">Set up the cron job and run: <code>openclaw cron run email-digest</code></p>
    </div>`
  }
</body>
</html>`;
}

/**
 * Handles GET /digest (HTML) and GET /digest/data (JSON).
 * Returns false if the request path does not match.
 */
export function handleDigestDashboardRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname !== DIGEST_PATH && pathname !== DIGEST_DATA_PATH) {
    return false;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return true;
  }

  const digests = readDigests();

  if (pathname === DIGEST_DATA_PATH) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ digests, dir: DIGESTS_DIR }, null, 2));
    return true;
  }

  // GET /digest — serve HTML dashboard
  const html = renderHtml(digests);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(html);
  return true;
}
