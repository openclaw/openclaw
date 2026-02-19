/**
 * MCP Server Status Monitoring Service
 *
 * Fetches live MCP server status from Cloud.ru AI Fabric API,
 * maps health states, and returns a structured result.
 *
 * Reusable across: plugins, CLI commands, health endpoints, webhooks.
 */

import type { McpServer, McpServerStatus } from "./types.js";
import { describeNetworkError } from "../infra/errors.js";
import { CloudruAuthError } from "./cloudru-auth.js";
import { CloudruSimpleClient } from "./cloudru-client-simple.js";
import { CloudruApiError } from "./cloudru-client.js";

// ---------------------------------------------------------------------------
// Health model
// ---------------------------------------------------------------------------

export type McpServerHealth = "healthy" | "degraded" | "failed" | "unknown";

const HEALTH_MAP: Record<McpServerStatus, McpServerHealth> = {
  RUNNING: "healthy",
  AVAILABLE: "healthy",
  COOLED: "degraded",
  SUSPENDED: "degraded",
  ON_SUSPENDING: "degraded",
  ON_RESOURCE_ALLOCATION: "degraded",
  WAITING_FOR_SCRAPPING: "degraded",
  FAILED: "failed",
  DELETED: "failed",
  IMAGE_UNAVAILABLE: "failed",
  UNKNOWN: "unknown",
  ON_DELETION: "unknown",
};

export function mapMcpServerHealth(status: McpServerStatus): McpServerHealth {
  return HEALTH_MAP[status] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpStatusParams = {
  /** Cloud.ru AI Fabric project ID. */
  projectId: string;
  /** IAM credentials for token exchange. */
  auth: { keyId: string; secret: string };
  /** Optional filter: only show servers matching this name (case-insensitive substring). */
  nameFilter?: string;
  /** Override base URL (for testing). */
  baseUrl?: string;
  /** Override IAM URL (for testing). */
  iamUrl?: string;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
};

export type McpStatusEntry = {
  /** Server ID. */
  id: string;
  /** Server name. */
  name: string;
  /** Raw Cloud.ru status. */
  status: McpServerStatus;
  /** Mapped health state. */
  health: McpServerHealth;
  /** Available tools on this server. */
  tools: { name: string; description: string }[];
};

export type McpStatusSummary = {
  total: number;
  healthy: number;
  degraded: number;
  failed: number;
  unknown: number;
};

export type McpStatusResult = {
  ok: true;
  entries: McpStatusEntry[];
  summary: McpStatusSummary;
};

export type McpStatusErrorType = "auth" | "api" | "network" | "config";

export type McpStatusError = {
  ok: false;
  errorType: McpStatusErrorType;
  error: string;
};

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function getMcpServerStatus(
  params: McpStatusParams,
): Promise<McpStatusResult | McpStatusError> {
  if (!params.projectId) {
    return { ok: false, errorType: "config", error: "Missing projectId in aiFabric config" };
  }
  if (!params.auth.keyId || !params.auth.secret) {
    return {
      ok: false,
      errorType: "config",
      error: "Missing IAM credentials (keyId or secret)",
    };
  }

  let liveServers: McpServer[];
  try {
    const client = new CloudruSimpleClient({
      projectId: params.projectId,
      auth: params.auth,
      baseUrl: params.baseUrl,
      iamUrl: params.iamUrl,
      fetchImpl: params.fetchImpl,
    });

    const result = await client.listMcpServers({ limit: 100 });
    liveServers = result.data;
  } catch (err) {
    if (err instanceof CloudruAuthError) {
      return { ok: false, errorType: "auth", error: `IAM auth failed: ${err.message}` };
    }
    if (err instanceof CloudruApiError) {
      return {
        ok: false,
        errorType: "api",
        error: `Cloud.ru API error (${err.status}): ${err.message}`,
      };
    }
    return { ok: false, errorType: "network", error: describeNetworkError(err) };
  }

  // Filter out deleted servers
  const active = liveServers.filter((s) => s.status !== "DELETED" && s.status !== "ON_DELETION");

  // Map to entries
  const entries: McpStatusEntry[] = active.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    health: mapMcpServerHealth(s.status),
    tools: s.tools ?? [],
  }));

  // Apply name filter
  const filtered = params.nameFilter
    ? entries.filter((e) => e.name.toLowerCase().includes(params.nameFilter!.toLowerCase()))
    : entries;

  // Build summary
  const summary: McpStatusSummary = { total: 0, healthy: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const entry of filtered) {
    summary.total++;
    summary[entry.health]++;
  }

  return { ok: true, entries: filtered, summary };
}
