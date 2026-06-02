import type { ServerResponse } from "node:http";

/** Return true for HTTP methods that may serve static Control UI assets. */
export function isReadHttpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

/** Send a plain-text HTTP response without depending on the Control UI asset stack. */
export function respondPlainText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/** Send the shared Control UI 404 response. */
export function respondNotFound(res: ServerResponse): void {
  respondPlainText(res, 404, "Not Found");
}
