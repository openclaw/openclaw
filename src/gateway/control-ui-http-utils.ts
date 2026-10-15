import type { ServerResponse } from "node:http";
import path from "node:path";
import { acceptsMediaType, hasExplicitAcceptableMediaRange } from "./http-media-range.js";

export function isReadHttpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

export function acceptsControlUiHtmlResponse(accept: string | undefined): boolean {
  const normalized = accept?.trim();
  if (!normalized) {
    return true;
  }
  // XHTML is an explicit browser signal; wildcards must negotiate the actual HTML type.
  return (
    acceptsMediaType(normalized, "text/html; charset=utf-8") ||
    hasExplicitAcceptableMediaRange(normalized, "application/xhtml+xml")
  );
}

export function respondPlainText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (statusCode !== 204) {
    res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  }
  res.end(body);
}

export function respondNotFound(res: ServerResponse): void {
  respondPlainText(res, 404, "Not Found");
}

export function isExpectedSafePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

export function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  return !(
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("\0")
  );
}
