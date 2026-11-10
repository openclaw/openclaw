import { escapeHtml } from "./html-escape.js";
import { openClawMascotStyles, renderOpenClawMascot } from "./openclaw-mascot.js";
import { openClawWordmarkTextSvg } from "./openclaw-wordmark.js";

const PHONE_MEDIA =
  "@media(max-width:768px),(max-width:932px) and (max-height:500px) and (orientation:landscape)";
const MASCOT = renderOpenClawMascot("openclaw-oauth-mascot-shell");

// Callback transports admit exactly these bytes through their stylesheet CSP hash.
// Status geometry and theme tokens follow the Gateway's standalone availability page.
export const OAUTH_PAGE_STYLES = `
:root{color-scheme:light;--bg:#f8f8f8;--text:#353535;--text-strong:#202020;--muted:#5e5e5e;--detail-bg:#f1f2f5;--mascot-ground:radial-gradient(closest-side,rgb(32 32 32/.16),rgb(32 32 32/.06) 60%,transparent);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.55;letter-spacing:-.01em;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0e1015;--text:#bcbcc0;--text-strong:#f4f4f5;--muted:#8e8e97;--detail-bg:#22252a;--mascot-ground:radial-gradient(closest-side,rgb(0 0 0/.42),rgb(0 0 0/.16) 60%,transparent)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg)}
.shell{display:flex;flex-direction:column;min-height:100svh;min-width:0}
.topbar{display:flex;align-items:flex-start;justify-content:center;padding:14.5px 12px 0}
.wordmark{display:block;width:105px;height:32px;color:var(--text-strong)}
main{position:relative;flex:1;min-height:calc(100svh - 64px)}
.body{position:absolute;top:38%;left:50%;width:min(460px,calc(100% - 48px));transform:translateX(-50%);text-align:center;overflow-wrap:anywhere}
h1{position:relative;margin:0;color:var(--text-strong);font-size:22px;font-weight:600;line-height:28px;letter-spacing:-.01em;text-wrap:balance}
p{margin:6px 0 0;color:var(--muted);font-size:14px;line-height:21px;text-wrap:pretty}
.details{margin-top:24px;padding:14px 16px;border-radius:12px;background:var(--detail-bg);color:var(--muted);font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;text-align:left;white-space:pre-wrap}
${PHONE_MEDIA}{.shell{padding:0 4px}.body{top:36%;left:24px;right:24px;width:auto;transform:none}h1{font-size:20px;line-height:26px}}
${openClawMascotStyles({
  busy: ".mascot[data-pose=busy]",
  error: "[data-state=error] .mascot",
  phone: PHONE_MEDIA,
})}
`;

export function renderOAuthPage(options: {
  title: string;
  heading: string;
  message: string;
  details?: string;
  state?: "error";
}): string {
  const title = escapeHtml(options.title);
  const heading = escapeHtml(options.heading);
  const message = escapeHtml(options.message);
  const details = options.details ? escapeHtml(options.details) : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1,viewport-fit=cover" />
  <meta name="color-scheme" content="light dark" />
  <title>${title}</title>
  <style>${OAUTH_PAGE_STYLES}</style>
</head>
<body data-state="${options.state === "error" ? "error" : "success"}">
  <div class="shell">
    <header class="topbar">${openClawWordmarkTextSvg}</header>
    <main><div class="body">
      <h1>${MASCOT}${heading}</h1>
      <p>${message}</p>
      ${details ? `<div class="details">${details}</div>` : ""}
    </div></main>
  </div>
</body>
</html>`;
}

/** Renders the local OAuth callback success page after provider authentication completes. */
export function oauthSuccessHtml(message: string): string {
  return renderOAuthPage({
    title: "Account connected",
    heading: "You’re connected",
    message,
  });
}

/** Renders the local OAuth callback error page without exposing raw credential material. */
export function oauthErrorHtml(message: string, details?: string): string {
  return renderOAuthPage({
    title: "Sign-in incomplete",
    heading: "Sign-in didn’t complete",
    state: "error",
    message,
    details,
  });
}
