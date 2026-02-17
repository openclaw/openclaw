import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";

const QUOTA_PATH_RE = /^\/v1\/quota\/([^/]+)$/;

export async function handleQuotaHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = QUOTA_PATH_RE.exec(url.pathname);
  if (!match || req.method !== "GET") {
    return false;
  }

  const customerId = decodeURIComponent(match[1]);
  const config = loadConfig();

  if (!config.quota?.enabled) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "quota is not enabled" }));
    return true;
  }

  try {
    const { checkQuota } = await import("../quota/index.js");
    const status = await checkQuota(customerId, config);
    if (!status) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `No quota configuration for customer: ${customerId}` }));
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(status));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: String(err) }));
  }
  return true;
}
