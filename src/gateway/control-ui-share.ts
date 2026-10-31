import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";
import { escapeHtml } from "../shared/html-escape.js";
import { isReadHttpMethod, respondNotFound } from "./control-ui-http-utils.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
} from "./ingress-attribution.js";

/** This namespace contains only public preview documents and their generic brand media. */
export function isControlUiSharePath(pathname: string, basePath: string): boolean {
  return pathname === `${basePath}/share` || pathname.startsWith(`${basePath}/share/`);
}

export function serveControlUiShareDocument(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  basePath: string,
  publicOrigin?: string,
): void {
  const targetPath = url.pathname.slice(`${basePath}/share`.length);
  // Reuse the session URL grammar without looking up state, even existence.
  // Preserve the encoded path: keys may contain escaped slashes or spaces.
  const session = parseControlUiSessionPath(targetPath);
  if (!isReadHttpMethod(req.method) || url.href.length > 8192 || !session) {
    respondNotFound(res);
    return;
  }
  const ingress = getRemoteControlUiIngressContext(req);
  assertRemoteControlUiIngressCurrent(ingress);
  const origin = resolveControlUiShareOrigin(req, ingress?.publicOrigin ?? publicOrigin);
  if (!origin) {
    respondNotFound(res);
    return;
  }
  const search = new URLSearchParams();
  const catalogRouting = ["catalog", "host", "thread"].map(
    (key) => [key, url.searchParams.get(key)] as const,
  );
  if (catalogRouting.every(([, value]) => value)) {
    for (const [key, value] of catalogRouting) {
      if (value) {
        search.set(key, value);
      }
    }
  }
  // Only routing fields survive. Never echo credentials, drafts, or arbitrary query text.
  const suffix = search.size ? `?${search}` : "";
  const target = escapeHtml(`${basePath}${targetPath}${suffix}`);
  const canonical = escapeHtml(`${origin}${url.pathname}${suffix}`);
  const image = escapeHtml(`${origin}${basePath}/share/card.png`);
  const video = escapeHtml(`${origin}${basePath}/share/preview-v1.mp4`);
  const imageAlt = "OpenClaw lobster and creative ideas: Your ideas. In motion.";
  const title = session.namespace === "dashboard" ? "OpenClaw dashboard" : "OpenClaw session";
  const description = "Open this shared link in OpenClaw. Access to the session is required.";
  const body = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="robots" content="noindex, nofollow">
<meta property="og:type" content="website"><meta property="og:site_name" content="OpenClaw">
<meta property="og:title" content="${title}"><meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}"><meta property="og:image" content="${image}">
<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${imageAlt}">
<meta property="og:video" content="${video}">
${origin.startsWith("https:") ? `<meta property="og:video:secure_url" content="${video}">` : ""}
<meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1200"><meta property="og:video:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}"><meta name="twitter:image:alt" content="${imageAlt}">
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1016;color:#f5f7fa}
body{margin:0;min-height:100svh;display:grid;place-items:center}main{width:min(680px,calc(100% - 40px));padding:40px 0}
img,video{display:block;width:100%;height:auto;aspect-ratio:1200/630;border-radius:20px}video:focus-visible{outline:3px solid #fff;outline-offset:5px}h1{font-size:clamp(28px,5vw,40px);letter-spacing:-.04em;margin:28px 0 12px}
p{color:#b2bdc9;line-height:1.6;margin:0 0 28px}a{display:inline-block;border-radius:12px;padding:14px 22px;background:#ff5c50;color:#160b0a;font-weight:700;text-decoration:none}
details{margin-top:12px}summary{width:fit-content;cursor:pointer;color:#b2bdc9;padding:8px 0}details[open] video{margin-top:12px}
a:focus-visible,summary:focus-visible{outline:3px solid #fff;outline-offset:5px}
</style></head><body><main>
<img src="${image}" width="1200" height="630" alt="${imageAlt}">
<details><summary>Play animation (5 seconds)</summary>
<video controls playsinline preload="none" poster="${image}" width="1200" height="630" aria-label="${imageAlt}">
<source src="${video}" type="video/mp4">
Your browser does not support video. The still preview is shown above.
</video></details>
<h1>${title}</h1><p>${description}</p><a href="${target}">Open ${title === "OpenClaw dashboard" ? "dashboard" : "session"}</a>
</main></body></html>`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors ${ingress?.frameAncestors.length ? ingress.frameAncestors.join(" ") : "'none'"}; form-action 'none'`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(req.method === "HEAD" ? undefined : body);
}

export function resolveControlUiShareOrigin(
  req: IncomingMessage,
  publicOrigin?: string,
): string | null {
  const protocol = req.socket instanceof TLSSocket ? "https" : "http";
  const address = URL.parse(publicOrigin ?? `${protocol}://${req.headers.host}`);
  if (
    !address ||
    !/^https?:$/u.test(address.protocol) ||
    address.username ||
    address.password ||
    address.pathname !== "/" ||
    address.search ||
    address.hash
  ) {
    return null;
  }
  return address.origin;
}
