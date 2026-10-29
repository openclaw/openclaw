import type { ServerResponse } from "node:http";
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
