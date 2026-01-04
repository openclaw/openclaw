import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { extname, join, basename } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import MarkdownIt from "markdown-it";
import { CONFIG_DIR } from "../utils.js";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

export type ServeMetadata = {
  slug: string;
  contentPath: string;
  contentHash: string;
  contentType: string;
  size: number;
  title: string;
  description: string;
  ogImage: string | null;
  createdAt: string;
  expiresAt: string | null;
  ttl: string;
};

export type ServeCreateParams = {
  path: string;
  slug: string;
  title: string;
  description: string;
  ttl?: string;
  ogImage?: string;
};

const SERVE_DIR = join(CONFIG_DIR, "serve");

function ensureServeDir() {
  if (!existsSync(SERVE_DIR)) {
    mkdirSync(SERVE_DIR, { recursive: true });
  }
}

export function parseTtl(ttl: string): number | null {
  if (ttl === "forever") return null;
  const match = ttl.match(/^(\d+)(m|h|d)$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function getMimeType(ext: string): string {
  const mimes: Record<string, string> = {
    ".md": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".css": "text/css",
    ".js": "application/javascript",
  };
  return mimes[ext.toLowerCase()] ?? "application/octet-stream";
}

function findUniqueSlug(baseSlug: string): string {
  ensureServeDir();
  let slug = baseSlug;
  let counter = 1;
  while (existsSync(join(SERVE_DIR, `${slug}.json`))) {
    const existing = loadMetadata(slug);
    if (!existing) break;
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  return slug;
}

function loadMetadata(slug: string): ServeMetadata | null {
  const metaPath = join(SERVE_DIR, `${slug}.json`);
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as ServeMetadata;
  } catch {
    return null;
  }
}

function saveMetadata(meta: ServeMetadata) {
  ensureServeDir();
  const metaPath = join(SERVE_DIR, `${meta.slug}.json`);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function isExpired(meta: ServeMetadata): boolean {
  if (!meta.expiresAt) return false;
  return new Date(meta.expiresAt).getTime() < Date.now();
}

function deleteServedContent(slug: string) {
  const meta = loadMetadata(slug);
  if (!meta) return false;
  const metaPath = join(SERVE_DIR, `${slug}.json`);
  const contentPath = join(SERVE_DIR, meta.contentPath);
  try {
    if (existsSync(contentPath)) unlinkSync(contentPath);
    if (existsSync(metaPath)) unlinkSync(metaPath);
    return true;
  } catch {
    return false;
  }
}

export function serveCreate(
  params: ServeCreateParams,
  baseUrl: string,
): { url: string; slug: string } {
  ensureServeDir();

  if (!existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }

  const content = readFileSync(params.path);
  const hash = hashContent(content);
  const ext = extname(params.path);
  const contentType = getMimeType(ext);

  // Check for existing with same slug
  const existing = loadMetadata(params.slug);
  let slug: string;

  if (existing && existing.contentHash === hash) {
    // Same content, update metadata
    slug = params.slug;
  } else if (existing) {
    // Different content, find unique slug
    slug = findUniqueSlug(params.slug);
  } else {
    slug = params.slug;
  }

  const contentFilename = `${slug}${ext}`;
  const contentPath = join(SERVE_DIR, contentFilename);
  copyFileSync(params.path, contentPath);

  const ttl = params.ttl ?? "24h";
  const ttlMs = parseTtl(ttl);
  const now = new Date();
  const expiresAt = ttlMs ? new Date(now.getTime() + ttlMs).toISOString() : null;

  const meta: ServeMetadata = {
    slug,
    contentPath: contentFilename,
    contentHash: hash,
    contentType,
    size: content.length,
    title: params.title,
    description: params.description,
    ogImage: params.ogImage ?? null,
    createdAt: now.toISOString(),
    expiresAt,
    ttl,
  };

  saveMetadata(meta);

  return { url: `${baseUrl}/s/${slug}`, slug };
}

export function serveList(baseUrl: string): ServeMetadata[] {
  ensureServeDir();
  const files = readdirSync(SERVE_DIR).filter((f) => f.endsWith(".json"));
  const items: ServeMetadata[] = [];

  for (const file of files) {
    const slug = file.replace(/\.json$/, "");
    const meta = loadMetadata(slug);
    if (meta && !isExpired(meta)) {
      items.push(meta);
    }
  }

  return items;
}

export function serveDelete(slug: string): boolean {
  return deleteServedContent(slug);
}

// CSS for rendered pages
const CSS = `
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
  color: #333;
  max-width: 700px;
  margin: 0 auto;
  padding: 20px;
  background: #fff;
}
h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
h1 { font-size: 2em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
p { margin: 1em 0; }
a { color: #0066cc; }
img { max-width: 100%; height: auto; }
pre { background: #f5f5f5; padding: 1em; overflow-x: auto; border-radius: 4px; }
code { background: #f5f5f5; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding-left: 1em; color: #666; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
th { background: #f5f5f5; }
`;

const HIGHLIGHT_CSS = `
.hljs{background:#f5f5f5;padding:0}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-section,.hljs-link{color:#a626a4}
.hljs-string,.hljs-title,.hljs-name,.hljs-type,.hljs-attribute,.hljs-symbol,.hljs-bullet,.hljs-addition,.hljs-variable,.hljs-template-tag,.hljs-template-variable{color:#50a14f}
.hljs-comment,.hljs-quote,.hljs-deletion,.hljs-meta{color:#a0a1a7}
.hljs-number,.hljs-regexp,.hljs-literal,.hljs-bullet,.hljs-link{color:#986801}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:bold}
`;

function renderHtmlPage(meta: ServeMetadata, bodyHtml: string, baseUrl: string): string {
  const ogImageTag = meta.ogImage
    ? `<meta property="og:image" content="${baseUrl}/s/${meta.ogImage}">`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:title" content="${escapeHtml(meta.title)}">
  <meta property="og:description" content="${escapeHtml(meta.description)}">
  ${ogImageTag}
  <meta property="og:type" content="article">
  <title>${escapeHtml(meta.title)}</title>
  <style>${CSS}</style>
  <style>${HIGHLIGHT_CSS}</style>
</head>
<body>
  <main>
    ${bodyHtml}
  </main>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>hljs.highlightAll();</script>
</body>
</html>`;
}

function render404Page(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Not Found - Clawdis</title>
  <style>${CSS}</style>
</head>
<body>
  <main style="text-align: center; padding-top: 50px;">
    <h1>Content Not Found</h1>
    <p>This content may have expired or been removed.</p>
  </main>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function handleServeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { baseUrl: string },
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/s/")) return false;

  const slug = url.pathname.slice(3); // Remove "/s/"
  if (!slug || slug.includes("/")) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(render404Page());
    return true;
  }

  const meta = loadMetadata(slug);
  if (!meta || isExpired(meta)) {
    if (meta && isExpired(meta)) {
      deleteServedContent(slug);
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(render404Page());
    return true;
  }

  const contentPath = join(SERVE_DIR, meta.contentPath);
  if (!existsSync(contentPath)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(render404Page());
    return true;
  }

  const content = readFileSync(contentPath);

  // Render markdown/text as HTML
  if (meta.contentType === "text/markdown" || meta.contentType === "text/plain") {
    const text = content.toString("utf-8");
    const bodyHtml = meta.contentType === "text/markdown" ? md.render(text) : `<pre>${escapeHtml(text)}</pre>`;
    const html = renderHtmlPage(meta, bodyHtml, opts.baseUrl);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return true;
  }

  // Serve other files directly
  res.statusCode = 200;
  res.setHeader("Content-Type", meta.contentType);
  res.setHeader("Content-Length", content.length);
  res.end(content);
  return true;
}
