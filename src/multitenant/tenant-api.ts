import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
} from "../gateway/http-common.js";
import { authenticateAdminRequest } from "./tenant-auth.js";
import {
  createTenant,
  getTenant,
  listTenants,
  updateTenant,
  suspendTenant,
} from "./tenant-store.js";

// ── Route matching ─────────────────────────────────────────────────

const TENANTS_BASE = "/api/v1/tenants";

function parseTenantIdFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(`${TENANTS_BASE}/`)) {
    return undefined;
  }
  const rest = pathname.slice(TENANTS_BASE.length + 1);
  // Must be a UUID-like segment, no further slashes
  if (!rest || rest.includes("/")) {
    return undefined;
  }
  return rest;
}

// ── Handler ────────────────────────────────────────────────────────

/**
 * Handle tenant management REST endpoints.
 * All endpoints require admin authentication (OPENCLAW_ADMIN_TOKEN).
 *
 * Routes:
 *   POST   /api/v1/tenants        → Create tenant
 *   GET    /api/v1/tenants        → List tenants
 *   GET    /api/v1/tenants/:id    → Get tenant
 *   PATCH  /api/v1/tenants/:id    → Update tenant
 *   DELETE /api/v1/tenants/:id    → Suspend tenant
 */
export async function handleTenantManagementRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // Only handle /api/v1/tenants paths
  if (!pathname.startsWith(TENANTS_BASE)) {
    return false;
  }
  if (pathname !== TENANTS_BASE && !pathname.startsWith(`${TENANTS_BASE}/`)) {
    return false;
  }

  // All tenant management endpoints require admin auth
  if (!authenticateAdminRequest(req)) {
    sendUnauthorized(res);
    return true;
  }

  const tenantId = parseTenantIdFromPath(pathname);

  // ── Collection routes: /api/v1/tenants ───────────────────────
  if (!tenantId) {
    if (req.method === "POST") {
      return await handleCreateTenant(req, res);
    }
    if (req.method === "GET") {
      return await handleListTenants(res);
    }
    sendMethodNotAllowed(res, "GET, POST");
    return true;
  }

  // ── Individual routes: /api/v1/tenants/:id ───────────────────
  if (req.method === "GET") {
    return await handleGetTenant(res, tenantId);
  }
  if (req.method === "PATCH") {
    return await handleUpdateTenant(req, res, tenantId);
  }
  if (req.method === "DELETE") {
    return await handleSuspendTenant(res, tenantId);
  }

  sendMethodNotAllowed(res, "GET, PATCH, DELETE");
  return true;
}

// ── Individual handlers ────────────────────────────────────────────

async function handleCreateTenant(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBodyOrError(req, res, 64 * 1024);
  if (body === undefined) {
    return true;
  }

  const { name, llm_provider, llm_api_key } = body as {
    name?: string;
    llm_provider?: string;
    llm_api_key?: string;
  };

  if (!name?.trim()) {
    sendJson(res, 400, {
      error: { message: "Missing required field: name", type: "invalid_request_error" },
    });
    return true;
  }
  if (!llm_api_key?.trim()) {
    sendJson(res, 400, {
      error: { message: "Missing required field: llm_api_key", type: "invalid_request_error" },
    });
    return true;
  }

  try {
    const result = await createTenant({
      name: name.trim(),
      llmProvider: llm_provider?.trim(),
      llmApiKey: llm_api_key.trim(),
    });

    sendJson(res, 201, {
      id: result.tenant.id,
      name: result.tenant.name,
      platform_api_key: result.platformApiKey,
      llm_provider: result.tenant.llmProvider,
      status: result.tenant.status,
      created_at: new Date(result.tenant.createdAt).toISOString(),
    });
  } catch (err) {
    sendJson(res, 500, { error: { message: String(err), type: "server_error" } });
  }

  return true;
}

async function handleListTenants(res: ServerResponse): Promise<boolean> {
  try {
    const tenants = await listTenants();
    sendJson(res, 200, {
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        llm_provider: t.llmProvider,
        status: t.status,
        created_at: new Date(t.createdAt).toISOString(),
        updated_at: new Date(t.updatedAt).toISOString(),
      })),
    });
  } catch (err) {
    sendJson(res, 500, { error: { message: String(err), type: "server_error" } });
  }
  return true;
}

async function handleGetTenant(res: ServerResponse, tenantId: string): Promise<boolean> {
  try {
    const tenant = await getTenant(tenantId);
    if (!tenant) {
      sendJson(res, 404, { error: { message: "Tenant not found", type: "not_found" } });
      return true;
    }
    sendJson(res, 200, {
      id: tenant.id,
      name: tenant.name,
      llm_provider: tenant.llmProvider,
      status: tenant.status,
      created_at: new Date(tenant.createdAt).toISOString(),
      updated_at: new Date(tenant.updatedAt).toISOString(),
    });
  } catch (err) {
    sendJson(res, 500, { error: { message: String(err), type: "server_error" } });
  }
  return true;
}

async function handleUpdateTenant(
  req: IncomingMessage,
  res: ServerResponse,
  tenantId: string,
): Promise<boolean> {
  const body = await readJsonBodyOrError(req, res, 64 * 1024);
  if (body === undefined) {
    return true;
  }

  const { name, llm_api_key } = body as {
    name?: string;
    llm_api_key?: string;
  };

  if (name === undefined && llm_api_key === undefined) {
    sendJson(res, 400, {
      error: { message: "No fields to update", type: "invalid_request_error" },
    });
    return true;
  }

  try {
    const updated = await updateTenant(tenantId, {
      name: name?.trim(),
      llmApiKey: llm_api_key?.trim(),
    });
    if (!updated) {
      sendJson(res, 404, { error: { message: "Tenant not found", type: "not_found" } });
      return true;
    }
    sendJson(res, 200, {
      id: updated.id,
      name: updated.name,
      llm_provider: updated.llmProvider,
      status: updated.status,
      updated_at: new Date(updated.updatedAt).toISOString(),
    });
  } catch (err) {
    sendJson(res, 500, { error: { message: String(err), type: "server_error" } });
  }
  return true;
}

async function handleSuspendTenant(res: ServerResponse, tenantId: string): Promise<boolean> {
  try {
    const updated = await suspendTenant(tenantId);
    if (!updated) {
      sendJson(res, 404, { error: { message: "Tenant not found", type: "not_found" } });
      return true;
    }
    sendJson(res, 200, {
      id: updated.id,
      status: updated.status,
    });
  } catch (err) {
    sendJson(res, 500, { error: { message: String(err), type: "server_error" } });
  }
  return true;
}
