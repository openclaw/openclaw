import { escapeHtml } from "./html-escape.js";

// Static OpenClaw lobster mascot; keep shapes in sync with ui/public/favicon.svg.
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none" aria-hidden="true"><defs><linearGradient id="lobster-gradient" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path fill="url(#lobster-gradient)" d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"/><path fill="url(#lobster-gradient)" d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"/><path fill="url(#lobster-gradient)" d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"/><path stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" d="M45 15 Q35 5 30 8"/><path stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" d="M75 15 Q85 5 90 8"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2.5" fill="#00e5cc"/><circle cx="76" cy="34" r="2.5" fill="#00e5cc"/></svg>`;

// Callback transports admit exactly these bytes through their stylesheet CSP hash.
export const OAUTH_PAGE_STYLES = `
    :root {
      color-scheme: light dark;
      --text: #191b20;
      --text-dim: #60646d;
      --page-bg: #f5f6f8;
      --surface: #ffffff;
      --detail-bg: #f1f2f5;
      --shadow: 0 16px 52px rgb(24 30 42 / 0.07);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-synthesis: none;
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --text: #f2f3f5;
        --text-dim: #a9afb9;
        --page-bg: #0f1012;
        --surface: #181a1e;
        --detail-bg: #22252a;
        --shadow: 0 16px 52px rgb(0 0 0 / 0.18);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      text-align: center;
    }
    main {
      width: min(100%, 480px);
      padding: clamp(28px, 6vw, 44px) clamp(24px, 5vw, 40px);
      border-radius: 24px;
      background: var(--surface);
      box-shadow: var(--shadow);
      overflow-wrap: anywhere;
    }
    .logo {
      width: 56px;
      height: 56px;
      margin: 0 auto 24px;
    }
    .logo svg { display: block; width: 100%; height: 100%; }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(23px, 5vw, 28px);
      line-height: 1.2;
      font-weight: 650;
      letter-spacing: -0.035em;
      text-wrap: balance;
    }
    p {
      margin: 0;
      color: var(--text-dim);
      font-size: 15px;
      line-height: 1.65;
    }
    .details {
      margin-top: 24px;
      padding: 14px 16px;
      border-radius: 12px;
      background: var(--detail-bg);
      color: var(--text-dim);
      font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-align: left;
      white-space: pre-wrap;
    }
`;

export function renderOAuthPage(options: {
  title: string;
  heading: string;
  message: string;
  details?: string;
}): string {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${title}</title>
  <style>${OAUTH_PAGE_STYLES}</style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

/** Renders the local OAuth callback page after an authorization code is received. */
export function oauthSuccessHtml(message: string): string {
  return renderOAuthPage({
    title: "Authorization received",
    heading: "Authorization received",
    message,
  });
}

/** Renders the local OAuth callback error page without exposing raw credential material. */
export function oauthErrorHtml(message: string, details?: string): string {
  return renderOAuthPage({
    title: "Authentication failed",
    heading: "Authentication failed",
    message,
    details,
  });
}
