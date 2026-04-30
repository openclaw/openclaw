import { resolveAgentConfig, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_EVERY,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
} from "../auto-reply/heartbeat.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { AgentDefaultsConfig, HeartbeatConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

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

function isHeartbeatConfigEnabled(
  heartbeat: AgentDefaultsConfig["heartbeat"],
): heartbeat is HeartbeatConfig {
  return Boolean(heartbeat) && heartbeat !== false;
}

function hasExplicitHeartbeatAgents(cfg: OpenClawConfig) {
  const list = cfg.agents?.list ?? [];
  return list.some((entry) => isHeartbeatConfigEnabled(entry?.heartbeat));
}

export function isHeartbeatEnabledForAgent(cfg: OpenClawConfig, agentId?: string): boolean {
  const resolvedAgentId = normalizeAgentId(agentId ?? resolveDefaultAgentId(cfg));
  const list = cfg.agents?.list ?? [];
  const hasExplicit = hasExplicitHeartbeatAgents(cfg);
  if (hasExplicit) {
    return list.some(
      (entry) =>
        isHeartbeatConfigEnabled(entry?.heartbeat) &&
        normalizeAgentId(entry?.id) === resolvedAgentId,
    );
  }
  const defaultsHeartbeat = cfg.agents?.defaults?.heartbeat;
  if (defaultsHeartbeat === false) {
    return false;
  }
  return resolvedAgentId === resolveDefaultAgentId(cfg);
}

export function resolveHeartbeatIntervalMs(
  cfg: OpenClawConfig,
  overrideEvery?: string,
  heartbeat?: HeartbeatConfig,
) {
  const defaultsHeartbeat = cfg.agents?.defaults?.heartbeat;
  const raw =
    overrideEvery ??
    heartbeat?.every ??
    (defaultsHeartbeat === false
      ? undefined
      : (defaultsHeartbeat?.every ?? DEFAULT_HEARTBEAT_EVERY));
  if (!raw) {
    return null;
  }
  const trimmed = normalizeOptionalString(raw) ?? "";
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
  const defaults = isHeartbeatConfigEnabled(cfg.agents?.defaults?.heartbeat)
    ? cfg.agents?.defaults?.heartbeat
    : undefined;
  const agentHeartbeat = agentId ? resolveAgentConfig(cfg, agentId)?.heartbeat : undefined;
  const overrides = isHeartbeatConfigEnabled(agentHeartbeat) ? agentHeartbeat : undefined;
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
