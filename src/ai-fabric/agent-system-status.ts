/**
 * Agent System Status Monitoring Service
 *
 * Fetches live agent system status from Cloud.ru AI Fabric API,
 * maps health states, and returns a structured result.
 *
 * Reusable across: plugins, CLI commands, health endpoints, webhooks.
 */

import type { AgentSystem, AgentSystemStatus } from "./types.js";
import { describeNetworkError } from "../infra/errors.js";
import { CloudruAuthError } from "./cloudru-auth.js";
import { CloudruSimpleClient } from "./cloudru-client-simple.js";
import { CloudruApiError } from "./cloudru-client.js";

// ---------------------------------------------------------------------------
// Health model
// ---------------------------------------------------------------------------

export type AgentSystemHealth = "healthy" | "degraded" | "failed" | "unknown";

const HEALTH_MAP: Record<AgentSystemStatus, AgentSystemHealth> = {
  RUNNING: "healthy",
  COOLED: "degraded",
  SUSPENDED: "degraded",
  PULLING: "degraded",
  RESOURCE_ALLOCATION: "degraded",
  AGENT_UNAVAILABLE: "degraded",
  ON_SUSPENSION: "degraded",
  FAILED: "failed",
  DELETED: "failed",
  UNKNOWN: "unknown",
  ON_DELETION: "unknown",
};

/**
 * Strip the `AGENT_SYSTEM_STATUS_` prefix that the Cloud.ru API sometimes returns.
 * e.g. `AGENT_SYSTEM_STATUS_RUNNING` → `RUNNING`
 */
export function normalizeAgentSystemStatus(raw: string): AgentSystemStatus {
  const stripped = raw.replace(/^AGENT_SYSTEM_STATUS_/, "");
  return (stripped in HEALTH_MAP ? stripped : raw) as AgentSystemStatus;
}

export function mapAgentSystemHealth(status: string): AgentSystemHealth {
  const normalized = normalizeAgentSystemStatus(status);
  return HEALTH_MAP[normalized] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentSystemStatusParams = {
  /** Cloud.ru AI Fabric project ID. */
  projectId: string;
  /** IAM credentials for token exchange. */
  auth: { keyId: string; secret: string };
  /** Optional filter: only show systems matching this name (case-insensitive substring). */
  nameFilter?: string;
  /** Override base URL (for testing). */
  baseUrl?: string;
  /** Override IAM URL (for testing). */
  iamUrl?: string;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
};

export type AgentSystemStatusEntry = {
  /** System ID. */
  id: string;
  /** System name. */
  name: string;
  /** System description. */
  description?: string;
  /** Raw Cloud.ru status. */
  status: AgentSystemStatus;
  /** Mapped health state. */
  health: AgentSystemHealth;
  /** System endpoint URL. */
  endpoint?: string;
  /** Number of member agents. */
  memberCount: number;
};

export type AgentSystemStatusSummary = {
  total: number;
  healthy: number;
  degraded: number;
  failed: number;
  unknown: number;
};

export type AgentSystemStatusResult = {
  ok: true;
  entries: AgentSystemStatusEntry[];
  summary: AgentSystemStatusSummary;
};

export type AgentSystemStatusErrorType = "auth" | "api" | "network" | "config";

export type AgentSystemStatusError = {
  ok: false;
  errorType: AgentSystemStatusErrorType;
  error: string;
};

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function getAgentSystemStatus(
  params: AgentSystemStatusParams,
): Promise<AgentSystemStatusResult | AgentSystemStatusError> {
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

  let liveSystems: AgentSystem[];
  try {
    const client = new CloudruSimpleClient({
      projectId: params.projectId,
      auth: params.auth,
      baseUrl: params.baseUrl,
      iamUrl: params.iamUrl,
      fetchImpl: params.fetchImpl,
    });

    const result = await client.listAgentSystems({ limit: 100 });
    liveSystems = result.data;
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

  // Filter out deleted/deleting systems
  const active = liveSystems.filter((s) => {
    const normalized = normalizeAgentSystemStatus(s.status);
    return normalized !== "DELETED" && normalized !== "ON_DELETION";
  });

  // Map to entries with normalized statuses
  const entries: AgentSystemStatusEntry[] = active.map((s) => {
    const normalized = normalizeAgentSystemStatus(s.status);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      status: normalized,
      health: mapAgentSystemHealth(normalized),
      endpoint: s.endpoint,
      memberCount: s.options?.agents?.length ?? 0,
    };
  });

  // Apply name filter
  const filtered = params.nameFilter
    ? entries.filter((e) => e.name.toLowerCase().includes(params.nameFilter!.toLowerCase()))
    : entries;

  // Build summary
  const summary: AgentSystemStatusSummary = {
    total: 0,
    healthy: 0,
    degraded: 0,
    failed: 0,
    unknown: 0,
  };
  for (const entry of filtered) {
    summary.total++;
    summary[entry.health]++;
  }

  return { ok: true, entries: filtered, summary };
}
