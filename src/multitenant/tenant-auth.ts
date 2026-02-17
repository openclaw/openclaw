import type { IncomingMessage } from "node:http";
import { getBearerToken } from "../gateway/http-utils.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { hashApiKey } from "./tenant-crypto.js";
import {
  resolveTenantAgentDir,
  resolveTenantWorkspaceDir,
  resolveTenantSessionsDir,
  tenantAgentId,
} from "./tenant-paths.js";
import { getTenantByApiKeyHash, decryptTenantLlmKey, type Tenant } from "./tenant-store.js";

// ── Types ──────────────────────────────────────────────────────────

export type TenantContext = {
  tenantId: string;
  tenantName: string;
  /** Virtual agent ID: "tenant-{tenantId}" */
  agentId: string;
  llmProvider: string;
  /** Decrypted LLM API key. */
  llmApiKey: string;
  agentDir: string;
  workspaceDir: string;
  sessionsDir: string;
};

// ── Authentication ─────────────────────────────────────────────────

/**
 * Authenticate an incoming HTTP request as a tenant.
 * Returns a TenantContext if valid, or undefined if not a tenant request.
 */
export async function authenticateTenantRequest(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TenantContext | undefined> {
  const token = getBearerToken(req);
  if (!token) {
    return undefined;
  }

  const keyHash = hashApiKey(token);
  const tenant = await getTenantByApiKeyHash(keyHash, env);
  if (!tenant) {
    return undefined;
  }
  if (tenant.status !== "active") {
    return undefined;
  }

  return buildTenantContext(tenant, env);
}

/**
 * Verify that a request carries a valid admin token.
 */
export function authenticateAdminRequest(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const adminToken = env.OPENCLAW_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    return false;
  }

  const token = getBearerToken(req);
  if (!token) {
    return false;
  }

  return safeEqualSecret(token, adminToken);
}

// ── Helpers ────────────────────────────────────────────────────────

function buildTenantContext(tenant: Tenant, env: NodeJS.ProcessEnv = process.env): TenantContext {
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    agentId: tenantAgentId(tenant.id),
    llmProvider: tenant.llmProvider,
    llmApiKey: decryptTenantLlmKey(tenant, env),
    agentDir: resolveTenantAgentDir(tenant.id, env),
    workspaceDir: resolveTenantWorkspaceDir(tenant.id, env),
    sessionsDir: resolveTenantSessionsDir(tenant.id, env),
  };
}
