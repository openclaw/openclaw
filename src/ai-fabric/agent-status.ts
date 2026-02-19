/**
 * Agent Status Monitoring Service
 *
 * Fetches live agent status from Cloud.ru AI Fabric API, compares with
 * local config, detects drift, and returns a structured result.
 *
 * Reusable across: skills, CLI commands, health endpoints, webhooks.
 */

import type { AiFabricAgentEntry } from "../config/types.ai-fabric.js";
import type { Agent, AgentStatus } from "./types.js";
import { describeNetworkError } from "../infra/errors.js";
import { CloudruAuthError } from "./cloudru-auth.js";
import { CloudruSimpleClient } from "./cloudru-client-simple.js";
import { CloudruApiError } from "./cloudru-client.js";

// ---------------------------------------------------------------------------
// Health model
// ---------------------------------------------------------------------------

export type AgentHealth = "healthy" | "degraded" | "failed" | "unknown";

const HEALTH_MAP: Record<AgentStatus, AgentHealth> = {
  RUNNING: "healthy",
  SUSPENDED: "degraded",
  COOLED: "degraded",
  PULLING: "degraded",
  RESOURCE_ALLOCATION: "degraded",
  LLM_UNAVAILABLE: "degraded",
  TOOL_UNAVAILABLE: "degraded",
  ON_SUSPENSION: "degraded",
  FAILED: "failed",
  DELETED: "failed",
  IMAGE_UNAVAILABLE: "failed",
  UNKNOWN: "unknown",
  ON_DELETION: "unknown",
};

export function mapAgentHealth(status: AgentStatus): AgentHealth {
  return HEALTH_MAP[status] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentStatusParams = {
  /** Cloud.ru AI Fabric project ID. */
  projectId: string;
  /** IAM credentials for token exchange. */
  auth: { keyId: string; secret: string };
  /** Configured agents from openclaw.json. */
  configuredAgents: AiFabricAgentEntry[];
  /** Optional filter: only show agents matching this name (case-insensitive substring). */
  nameFilter?: string;
  /** Override base URL (for testing). */
  baseUrl?: string;
  /** Override IAM URL (for testing). */
  iamUrl?: string;
  /** Custom fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
};

export type AgentStatusEntry = {
  /** Agent ID. */
  id: string;
  /** Agent name. */
  name: string;
  /** Raw Cloud.ru status. */
  status: AgentStatus;
  /** Mapped health state. */
  health: AgentHealth;
  /** Agent endpoint URL (from API, or config if agent deleted). */
  endpoint?: string;
  /** Whether this agent is in the local config. */
  configured: boolean;
  /** Whether config has drifted from live state. */
  drift: boolean;
  /** Human-readable drift reason, if any. */
  driftReason?: string;
};

export type AgentStatusSummary = {
  total: number;
  healthy: number;
  degraded: number;
  failed: number;
  unknown: number;
};

export type AgentStatusResult = {
  ok: true;
  entries: AgentStatusEntry[];
  summary: AgentStatusSummary;
};

export type AgentStatusErrorType = "auth" | "api" | "network" | "config";

export type AgentStatusError = {
  ok: false;
  errorType: AgentStatusErrorType;
  error: string;
};

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function getAgentStatus(
  params: AgentStatusParams,
): Promise<AgentStatusResult | AgentStatusError> {
  // Validate config
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

  // Fetch live agents from API
  let liveAgents: Agent[];
  try {
    const client = new CloudruSimpleClient({
      projectId: params.projectId,
      auth: params.auth,
      baseUrl: params.baseUrl,
      iamUrl: params.iamUrl,
      fetchImpl: params.fetchImpl,
    });

    const result = await client.listAgents({ limit: 100 });
    liveAgents = result.data;
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

  // Build lookup of live agents by ID
  const liveById = new Map<string, Agent>();
  for (const agent of liveAgents) {
    liveById.set(agent.id, agent);
  }

  const entries: AgentStatusEntry[] = [];
  const seenIds = new Set<string>();

  // Process configured agents — detect drift
  for (const configured of params.configuredAgents) {
    seenIds.add(configured.id);
    const live = liveById.get(configured.id);

    if (!live) {
      // Agent in config but deleted from Cloud.ru
      entries.push({
        id: configured.id,
        name: configured.name,
        status: "DELETED",
        health: "failed",
        endpoint: configured.endpoint,
        configured: true,
        drift: true,
        driftReason: "Agent not found in Cloud.ru (deleted or moved to another project)",
      });
      continue;
    }

    // Check endpoint drift
    let drift = false;
    let driftReason: string | undefined;
    if (live.endpoint && configured.endpoint && live.endpoint !== configured.endpoint) {
      drift = true;
      driftReason = `Endpoint changed: config has "${configured.endpoint}", Cloud.ru has "${live.endpoint}"`;
    }

    entries.push({
      id: live.id,
      name: live.name,
      status: live.status,
      health: mapAgentHealth(live.status),
      endpoint: live.endpoint,
      configured: true,
      drift,
      driftReason,
    });
  }

  // Process live agents not in config
  for (const live of liveAgents) {
    if (seenIds.has(live.id)) {
      continue;
    }
    entries.push({
      id: live.id,
      name: live.name,
      status: live.status,
      health: mapAgentHealth(live.status),
      endpoint: live.endpoint,
      configured: false,
      drift: false,
    });
  }

  // Apply name filter
  const filtered = params.nameFilter
    ? entries.filter((e) => e.name.toLowerCase().includes(params.nameFilter!.toLowerCase()))
    : entries;

  // Build summary
  const summary: AgentStatusSummary = { total: 0, healthy: 0, degraded: 0, failed: 0, unknown: 0 };
  for (const entry of filtered) {
    summary.total++;
    summary[entry.health]++;
  }

  return { ok: true, entries: filtered, summary };
}
