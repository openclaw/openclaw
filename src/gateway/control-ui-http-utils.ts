import type { ServerResponse } from "node:http";

/** Return true for Control UI asset methods that must not mutate server state. */
export function isReadHttpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

/** Send a plain text response with the shared Control UI content type. */
export function respondPlainText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/** Send the canonical Control UI 404 response used by router fallthroughs. */
export function respondNotFound(res: ServerResponse): void {
  respondPlainText(res, 404, "Not Found");
}
