import type { IncomingMessage, ServerResponse } from "node:http";
import { handleTenantManagementRequest } from "./tenant-api.js";
import { handleTenantChatRequest } from "./tenant-chat.js";

/**
 * Check whether multi-tenant mode is enabled.
 * Set OPENCLAW_MULTITENANT=1 to activate.
 */
function isMultitenantEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_MULTITENANT === "1";
}

/**
 * Aggregated HTTP handler for all multi-tenant API routes (/api/v1/*).
 *
 * Returns false immediately if multi-tenant mode is disabled (zero overhead).
 * Returns false for any non-/api/v1/ paths (fast rejection).
 */
export async function handleTenantApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!isMultitenantEnabled()) {
    return false;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/v1/")) {
    return false;
  }

  // Tenant management (admin auth)
  if (await handleTenantManagementRequest(req, res)) {
    return true;
  }

  // Tenant chat + sessions (tenant auth)
  if (await handleTenantChatRequest(req, res)) {
    return true;
  }

  return false;
}
