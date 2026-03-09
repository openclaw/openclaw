/**
 * Admin dashboard for the gateway operator.
 *
 * All routes under /admin/billing/* require the gateway Bearer token.
 * Only the operator (who knows the token) can access this.
 *
 * Routes:
 *   GET  /admin/billing           - HTML dashboard
 *   GET  /admin/billing/api/stats - JSON stats
 *   GET  /admin/billing/api/users - JSON user list
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getAllSubscriptions, getActiveSubscription } from "./subscription-store.js";
import { getAllUserUsage, getUsageSummary } from "./usage-tracker.js";
import { isStripeEnabled } from "./stripe-client.js";

const ADMIN_PREFIX = "/admin/billing";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function buildDashboardHtml(): string {
  const activeSub = isStripeEnabled() ? getActiveSubscription() : null;
  const allSubs = isStripeEnabled() ? getAllSubscriptions() : [];
  const users = getAllUserUsage();
  const summary = getUsageSummary();

  const subStatusBadge = !isStripeEnabled()
    ? `<span class="badge gray">Paywall disabled (no Stripe key)</span>`
    : activeSub
      ? `<span class="badge green">Active</span>`
      : `<span class="badge red">No active subscription</span>`;

  const subRows = allSubs.map((s) => `
    <tr>
      <td><code>${s.customerId}</code></td>
      <td><code>${s.subscriptionId}</code></td>
      <td><span class="badge ${s.status === "active" || s.status === "trialing" ? "green" : "red"}">${s.status}</span></td>
      <td>${new Date(s.currentPeriodEnd * 1000).toLocaleDateString()}</td>
      <td>${s.updatedAt}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="empty">No subscriptions recorded yet.</td></tr>`;

  const userRows = users.map((u) => `
    <tr>
      <td><code>${u.userId}…</code></td>
      <td>${u.label ? `<span class="label">${escHtml(u.label)}</span>` : "<em>—</em>"}</td>
      <td>${u.messagesSent.toLocaleString()}</td>
      <td>${u.estimatedTokens.toLocaleString()}</td>
      <td>${u.firstSeen.slice(0, 10)}</td>
      <td>${u.lastSeen.slice(0, 10)}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="empty">No usage recorded yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Admin — Billing</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: .25rem; color: #fff; }
    .subtitle { color: #64748b; font-size: .875rem; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: #1e2130; border: 1px solid #2d3148; border-radius: .75rem; padding: 1.25rem; }
    .card-label { font-size: .75rem; color: #64748b; text-transform: uppercase; letter-spacing: .05em; margin-bottom: .5rem; }
    .card-value { font-size: 2rem; font-weight: 700; color: #fff; }
    .card-sub { font-size: .8rem; color: #94a3b8; margin-top: .25rem; }
    section { margin-bottom: 2rem; }
    section h2 { font-size: 1rem; font-weight: 600; color: #cbd5e1; margin-bottom: .75rem;
                 display: flex; align-items: center; gap: .5rem; }
    .table-wrap { overflow-x: auto; border-radius: .5rem; border: 1px solid #2d3148; }
    table { width: 100%; border-collapse: collapse; font-size: .875rem; }
    th { background: #1a1d2e; color: #64748b; font-weight: 500; text-align: left;
         padding: .625rem .875rem; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
    td { padding: .625rem .875rem; border-top: 1px solid #2d3148; color: #cbd5e1; }
    tr:hover td { background: #1e2130; }
    .empty { text-align: center; color: #475569; padding: 2rem !important; }
    code { font-size: .8rem; color: #94a3b8; font-family: "SF Mono", monospace; }
    .badge { display: inline-flex; align-items: center; padding: .2rem .5rem;
             border-radius: 999px; font-size: .7rem; font-weight: 600; }
    .badge.green { background: #14532d; color: #4ade80; }
    .badge.red   { background: #450a0a; color: #f87171; }
    .badge.gray  { background: #1e293b; color: #94a3b8; }
    .label { display: inline-block; background: #1e3a5f; color: #7dd3fc;
             border-radius: .25rem; padding: .1rem .4rem; font-size: .75rem; }
    .actions { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: 2rem; }
    .btn { display: inline-flex; align-items: center; gap: .4rem; padding: .5rem 1rem;
           border-radius: .5rem; font-size: .875rem; font-weight: 500; cursor: pointer;
           border: none; text-decoration: none; }
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-primary:hover { background: #4f46e5; }
    .btn-ghost { background: #1e2130; color: #cbd5e1; border: 1px solid #2d3148; }
    .btn-ghost:hover { background: #2d3148; }
    .refresh { color: #475569; font-size: .75rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>OpenClaw Admin Dashboard</h1>
  <p class="subtitle">Billing &amp; Usage — gateway operator view only</p>

  <div class="grid">
    <div class="card">
      <div class="card-label">Subscription</div>
      <div class="card-value" style="font-size:1.1rem;margin-top:.25rem">${subStatusBadge}</div>
      ${activeSub ? `<div class="card-sub">Renews ${new Date(activeSub.currentPeriodEnd * 1000).toLocaleDateString()}</div>` : ""}
    </div>
    <div class="card">
      <div class="card-label">Total Users</div>
      <div class="card-value">${summary.totalUsers.toLocaleString()}</div>
      <div class="card-sub">unique token prefixes</div>
    </div>
    <div class="card">
      <div class="card-label">Messages Sent</div>
      <div class="card-value">${summary.totalMessages.toLocaleString()}</div>
      <div class="card-sub">all time</div>
    </div>
    <div class="card">
      <div class="card-label">Est. Tokens Used</div>
      <div class="card-value">${(summary.totalEstimatedTokens / 1000).toFixed(1)}k</div>
      <div class="card-sub">rough estimate</div>
    </div>
  </div>

  <div class="actions">
    <a class="btn btn-primary" href="/billing/checkout" onclick="return confirm('Open Stripe checkout?')">Subscribe / Upgrade</a>
    <a class="btn btn-ghost" href="/billing/portal" onclick="return confirm('Open Stripe billing portal?')">Manage Billing</a>
    <a class="btn btn-ghost" href="/billing/status">Subscription Status (JSON)</a>
    <a class="btn btn-ghost" href="/admin/billing/api/users">Users JSON</a>
  </div>

  <section>
    <h2>Subscriptions</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Customer ID</th><th>Subscription ID</th><th>Status</th>
          <th>Period End</th><th>Updated</th>
        </tr></thead>
        <tbody>${subRows}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>User Activity</h2>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>User ID (prefix)</th><th>Label</th><th>Messages</th>
          <th>Est. Tokens</th><th>First Seen</th><th>Last Seen</th>
        </tr></thead>
        <tbody>${userRows}</tbody>
      </table>
    </div>
  </section>

  <p class="refresh">Last rendered: ${new Date().toISOString()} · <a href="" style="color:#6366f1">Refresh</a></p>
</body>
</html>`;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Admin HTTP handler. Requires the gateway Bearer token (passed by the caller
 * via `authorized: boolean`). Returns true if the request was handled.
 */
export function handleAdminBillingHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { authorized: boolean },
): boolean {
  const url = req.url ?? "/";
  const requestPath = new URL(url, "http://localhost").pathname;

  if (!requestPath.startsWith(ADMIN_PREFIX)) {
    return false;
  }

  if (!opts.authorized) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("WWW-Authenticate", 'Bearer realm="openclaw-admin"');
    res.end(JSON.stringify({ ok: false, error: "Unauthorized. Gateway token required." }));
    return true;
  }

  const method = (req.method ?? "GET").toUpperCase();

  if (requestPath === ADMIN_PREFIX || requestPath === `${ADMIN_PREFIX}/`) {
    if (method !== "GET" && method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return true;
    }
    sendHtml(res, buildDashboardHtml());
    return true;
  }

  if (requestPath === `${ADMIN_PREFIX}/api/stats` && method === "GET") {
    const summary = getUsageSummary();
    const activeSub = isStripeEnabled() ? getActiveSubscription() : null;
    sendJson(res, 200, {
      ok: true,
      paywallEnabled: isStripeEnabled(),
      subscription: activeSub ?? null,
      usage: summary,
    });
    return true;
  }

  if (requestPath === `${ADMIN_PREFIX}/api/users` && method === "GET") {
    sendJson(res, 200, { ok: true, users: getAllUserUsage() });
    return true;
  }

  // Unknown /admin/billing/* sub-path
  sendJson(res, 404, { ok: false, error: "Not found" });
  return true;
}
