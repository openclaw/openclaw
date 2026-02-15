import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/**
 * Root directory for multi-tenant data.
 * Default: ~/.openclaw/tenants/
 */
export function resolveTenantStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "tenants");
}

/**
 * Path to the tenants registry JSON file.
 * Default: ~/.openclaw/tenants/tenants.json
 */
export function resolveTenantStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveTenantStoreDir(env), "tenants.json");
}

/**
 * Per-tenant agent directory (auth profiles, session metadata).
 * Maps to the standard agent dir layout that `resolveAgentDir()` defaults to
 * for unknown agent IDs: $STATE_DIR/agents/{agentId}/agent/
 */
export function resolveTenantAgentDir(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "agents", `tenant-${tenantId}`, "agent");
}

/**
 * Per-tenant workspace directory.
 * Maps to the standard workspace layout: $STATE_DIR/workspace-{agentId}/
 */
export function resolveTenantWorkspaceDir(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), `workspace-tenant-${tenantId}`);
}

/**
 * Per-tenant sessions directory.
 * Default: $STATE_DIR/agents/tenant-{tenantId}/sessions/
 */
export function resolveTenantSessionsDir(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "agents", `tenant-${tenantId}`, "sessions");
}

/** Virtual agent ID for a tenant. Used in session keys and path resolution. */
export function tenantAgentId(tenantId: string): string {
  return `tenant-${tenantId}`;
}
