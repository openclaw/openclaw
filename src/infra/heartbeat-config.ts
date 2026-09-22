/** Pure heartbeat enrollment and configuration shared by scheduling, health, and Doctor. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentConfig,
  withAgentRosterFactsBatch,
} from "../agents/agent-scope-config.js";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
import type { HeartbeatWakeSource } from "./heartbeat-wake-contracts.js";

export type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 10 * 60;

type HeartbeatAgent = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
};

export function resolveHeartbeatConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  return defaults || overrides ? { ...defaults, ...overrides } : undefined;
}

function omitExplicitHeartbeatDestination(heartbeat: HeartbeatConfig | undefined) {
  if (!heartbeat) {
    return undefined;
  }
  const next = { ...heartbeat };
  delete next.to;
  delete next.accountId;
  return next;
}

export function resolveHeartbeatForWake(params: {
  cfg: OpenClawConfig;
  agentId: string;
  configuredHeartbeat?: HeartbeatConfig;
  requestedHeartbeat?: HeartbeatConfig;
  source?: HeartbeatWakeSource;
}): HeartbeatConfig | undefined {
  const configuredHeartbeat =
    params.configuredHeartbeat ?? resolveHeartbeatConfig(params.cfg, params.agentId);
  const heartbeat = params.requestedHeartbeat
    ? { ...configuredHeartbeat, ...params.requestedHeartbeat }
    : configuredHeartbeat;
  return params.source === "cron" && params.requestedHeartbeat?.target === "last"
    ? omitExplicitHeartbeatDestination(heartbeat)
    : heartbeat;
}

/** Resolve the cadence owned by the effective heartbeat configuration. */
export function resolveHeartbeatIntervalMs(
  cfg: OpenClawConfig,
  overrideEvery?: string,
  heartbeat?: HeartbeatConfig,
) {
  const raw =
    overrideEvery ??
    heartbeat?.every ??
    cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return null;
  }
  try {
    const intervalMs = parseDurationMs(trimmed, { defaultUnit: "m" });
    return intervalMs > 0 ? intervalMs : null;
  } catch {
    return null;
  }
}

export function resolveHeartbeatTimeoutOverrideSeconds(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
) {
  if (typeof heartbeat?.timeoutSeconds === "number") {
    return heartbeat.timeoutSeconds;
  }
  const agentDefaultTimeoutSeconds = cfg.agents?.defaults?.timeoutSeconds;
  if (
    typeof agentDefaultTimeoutSeconds === "number" &&
    Number.isFinite(agentDefaultTimeoutSeconds)
  ) {
    // Preserve the unlimited sentinel consumed by resolveAgentTimeoutMs.
    return agentDefaultTimeoutSeconds === 0
      ? 0
      : Math.max(1, Math.floor(agentDefaultTimeoutSeconds));
  }
  // Monitor turns use their cadence budget instead of the 48h built-in agent default.
  const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, heartbeat);
  if (!intervalMs) {
    return DEFAULT_HEARTBEAT_TIMEOUT_SECONDS;
  }
  return Math.max(1, Math.min(DEFAULT_HEARTBEAT_TIMEOUT_SECONDS, Math.ceil(intervalMs / 1000)));
}

export function resolveHeartbeatAgentIds(cfg: OpenClawConfig): string[] {
  const explicitAgents = listAgentEntries(cfg).filter((entry) => entry.heartbeat);
  if (explicitAgents.length > 0) {
    return explicitAgents.map((entry) => normalizeAgentId(entry.id)).filter(Boolean);
  }
  const configuredAgentId = normalizeOptionalString(cfg.agents?.defaults?.heartbeat?.agentId);
  if (configuredAgentId) {
    return [normalizeAgentId(configuredAgentId)];
  }
  if (cfg.agents?.defaults?.heartbeat) {
    return listAgentIds(cfg);
  }
  const agentId = tryResolveAmbientHeartbeatAgentId(cfg);
  return agentId ? [agentId] : [];
}

export function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  return withAgentRosterFactsBatch(cfg, () =>
    resolveHeartbeatAgentIds(cfg).map((agentId) => ({
      agentId,
      heartbeat: resolveHeartbeatConfig(cfg, agentId),
    })),
  );
}

export function isHeartbeatOwnerUnresolved(cfg: OpenClawConfig): boolean {
  return listAgentIds(cfg).length > 1 && resolveHeartbeatAgentIds(cfg).length === 0;
}
