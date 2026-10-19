import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveAgentConfig } from "../../agent-scope-config.js";

const DEFAULT_SWARM_CONFIG = {
  enabled: true,
  maxConcurrent: 32,
  maxChildrenPerGroup: 50,
  maxTotalPerGroup: 200,
  waitTimeoutSecondsMax: 600,
  defaultAgentId: "",
};

function normalizeRawConfig(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "boolean") {
    return { enabled: value };
  }
  return isRecord(value) ? value : undefined;
}

function readSwarmLimit(
  raw: Record<string, unknown>,
  key: Exclude<keyof typeof DEFAULT_SWARM_CONFIG, "enabled" | "defaultAgentId">,
  max: number,
): number {
  const value = raw[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : DEFAULT_SWARM_CONFIG[key];
}

/** Resolve global and per-agent Swarm configuration into bounded runtime values. */
export function resolveSwarmConfig(
  config?: OpenClawConfig,
  agentId?: string,
): typeof DEFAULT_SWARM_CONFIG {
  const globalRaw = normalizeRawConfig(config?.tools?.swarm) ?? {};
  const agentRaw =
    config && agentId
      ? normalizeRawConfig(resolveAgentConfig(config, agentId)?.tools?.swarm)
      : undefined;
  const raw = agentRaw ? { ...globalRaw, ...agentRaw } : globalRaw;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SWARM_CONFIG.enabled,
    maxConcurrent: readSwarmLimit(raw, "maxConcurrent", 1_000),
    maxChildrenPerGroup: readSwarmLimit(raw, "maxChildrenPerGroup", 10_000),
    maxTotalPerGroup: readSwarmLimit(raw, "maxTotalPerGroup", 100_000),
    waitTimeoutSecondsMax: readSwarmLimit(raw, "waitTimeoutSecondsMax", 24 * 60 * 60),
    defaultAgentId: typeof raw.defaultAgentId === "string" ? raw.defaultAgentId.trim() : "",
  };
}
