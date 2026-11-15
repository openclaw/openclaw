import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveControlUiAllowedOrigins } from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function resolveControlUiImageCorsOrigin(
  req: IncomingMessage,
  cfg: OpenClawConfig,
): string | undefined {
  const rawOrigin = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (!rawOrigin) {
    return undefined;
  }
  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin !== rawOrigin || parsed.username || parsed.password) {
      return undefined;
    }
    origin = parsed.origin;
  } catch {
    return undefined;
  }
  const allowed = resolveControlUiAllowedOrigins(cfg);
  return allowed.some((candidate) => candidate.trim() === "*" || candidate.trim() === origin)
    ? origin
    : undefined;
}

export function setControlUiImageCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig,
): boolean {
  res.setHeader("Vary", "Origin, Authorization, Cookie");
  if (!req.headers.origin) {
    return true;
  }
  const origin = resolveControlUiImageCorsOrigin(req, cfg);
  if (!origin) {
    // Re-evaluation must retire a grant removed during asynchronous auth work.
    res.removeHeader("Access-Control-Allow-Origin");
    res.removeHeader("Access-Control-Allow-Credentials");
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  return true;
}
