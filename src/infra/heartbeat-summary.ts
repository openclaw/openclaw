import { resolveAgentConfig, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_EVERY,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
} from "../auto-reply/heartbeat.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { normalizeAgentId } from "../routing/session-key.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

export type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  ackMaxChars: number;
};

const DEFAULT_HEARTBEAT_TARGET = "none";

export function isHeartbeatEnabledForAgent(cfg: OpenClawConfig, agentId?: string): boolean {
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const list = cfg.agents?.list ?? [];
  const defaults = cfg.agents?.defaults?.heartbeat;
  const defaultAgentId = resolveDefaultAgentId(cfg);

  // Find the agent entry for this agent ID
  const agentEntry = list.find((entry) => normalizeAgentId(entry?.id) === resolvedAgentId);

  // If agent is not in the list, only enable if it's the default agent
  if (!agentEntry) {
    // Default agent without explicit list entry
    if (resolvedAgentId === defaultAgentId) {
      // Default agent: enabled if defaults exist, or by legacy behavior
      return Boolean(defaults) || list.length === 0;
    }
    // Non-default agent not in list -> not enabled
    return false;
  }

  // Agent is in the list
  // If agent has explicit heartbeat config, use it (could be intentionally enabled or disabled)
  if (agentEntry.heartbeat !== undefined) {
    return Boolean(agentEntry.heartbeat);
  }

  // Agent has no explicit heartbeat config:
  // - If defaults.heartbeat exists, inherit from defaults (enabled)
  // - Otherwise, only default agent is enabled (legacy behavior)
  if (defaults) {
    return true;
  }

  // No defaults, no explicit heartbeat -> only default agent is enabled
  return resolvedAgentId === defaultAgentId;
}

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
  if (!raw) {
    return null;
  }
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return null;
  }
  let ms: number;
  try {
    ms = parseDurationMs(trimmed, { defaultUnit: "m" });
  } catch {
    return null;
  }
  if (ms <= 0) {
    return null;
  }
  return ms;
}

export function resolveHeartbeatSummaryForAgent(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatSummary {
  const defaults = cfg.agents?.defaults?.heartbeat;
  const overrides = agentId ? resolveAgentConfig(cfg, agentId)?.heartbeat : undefined;
  const enabled = isHeartbeatEnabledForAgent(cfg, agentId);

  if (!enabled) {
    return {
      enabled: false,
      every: "disabled",
      everyMs: null,
      prompt: resolveHeartbeatPromptText(defaults?.prompt),
      target: defaults?.target ?? DEFAULT_HEARTBEAT_TARGET,
      model: defaults?.model,
      ackMaxChars: Math.max(0, defaults?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS),
    };
  }

  const merged = defaults || overrides ? { ...defaults, ...overrides } : undefined;
  const every = merged?.every ?? defaults?.every ?? overrides?.every ?? DEFAULT_HEARTBEAT_EVERY;
  const everyMs = resolveHeartbeatIntervalMs(cfg, undefined, merged);
  const prompt = resolveHeartbeatPromptText(
    merged?.prompt ?? defaults?.prompt ?? overrides?.prompt,
  );
  const target =
    merged?.target ?? defaults?.target ?? overrides?.target ?? DEFAULT_HEARTBEAT_TARGET;
  const model = merged?.model ?? defaults?.model ?? overrides?.model;
  const ackMaxChars = Math.max(
    0,
    merged?.ackMaxChars ??
      defaults?.ackMaxChars ??
      overrides?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  return {
    enabled: true,
    every,
    everyMs,
    prompt,
    target,
    model,
    ackMaxChars,
  };
}
