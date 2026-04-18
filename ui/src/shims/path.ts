/**
 * Minimal browser shim for `node:path` / `path`.
 * Only the subset actually reached by code that leaks into the UI bundle
 * (home-dir.ts, config/paths.ts) needs to work; everything else can be a
 * harmless no-op.
 */

const sep = "/";

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function join(...segments: string[]): string {
  return normalize(segments.filter(Boolean).join("/"));
}

function resolve(...segments: string[]): string {
  // In the browser we have no real filesystem; just join and normalise.
  return join(...segments) || "/";
}

function dirname(p: string): string {
  const parts = normalize(p).split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function basename(p: string, ext?: string): string {
  let base = normalize(p).split("/").pop() ?? "";
  if (ext && base.endsWith(ext)) {
    base = base.slice(0, -ext.length);
  }
  return base;
}

function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx) : "";
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function existsSync(_p: string): boolean {
  return false;
}

export default {
  sep,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  isAbsolute,
  existsSync,
};

export { sep, normalize, join, resolve, dirname, basename, extname, isAbsolute, existsSync };
