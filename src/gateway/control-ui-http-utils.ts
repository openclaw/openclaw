import type { ServerResponse } from "node:http";

/** Returns whether a Control UI route may serve a read-only HTTP request. */
export function isReadHttpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

/** Sends a UTF-8 plain-text Control UI response with the provided status code. */
export function respondPlainText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/** Sends the shared Control UI 404 response used by route and media handlers. */
export function respondNotFound(res: ServerResponse): void {
  respondPlainText(res, 404, "Not Found");
}
