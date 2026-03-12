import type { IncomingMessage, ServerResponse } from "node:http";
import { respondNotFound } from "./control-ui-http-utils.js";

function respondJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function handleVoiceConnectApiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  if (!url.pathname.startsWith("/voice-connect/api/")) {
    return false;
  }

  // Minimal health endpoint to verify the backend is mounted.
  if (req.method === "GET" && url.pathname === "/voice-connect/api/health") {
    respondJson(res, 200, { ok: true });
    return true;
  }

  respondNotFound(res);
  return true;
}
