import type { ServerResponse } from "node:http";

export function isReadHttpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

export function respondPlainText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

export function respondNotFound(res: ServerResponse): void {
  respondPlainText(res, 404, "Not Found");
}

export function respondMethodNotAllowed(res: ServerResponse): void {
  respondPlainText(res, 405, "Method Not Allowed");
}
