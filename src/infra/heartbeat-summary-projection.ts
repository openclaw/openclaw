/**
 * Heartbeat enrollment and per-agent summary projection shared by the public
 * heartbeat-summary module and internal status consumers. This stays outside
 * heartbeat-summary.ts so its internal helpers do not widen the wildcard
 * plugin SDK surface.
 */
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_EVERY,
  resolveHeartbeatPromptCore as resolveHeartbeatPromptText,
} from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
import {
  resolveHeartbeatAgentIds,
  resolveHeartbeatConfig,
  resolveHeartbeatIntervalMs,
} from "./heartbeat-config.js";

/** Normalized heartbeat configuration for one agent. */
export type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  session?: string;
  ackMaxChars: number;
};

const DEFAULT_HEARTBEAT_TARGET = "owner";

export function enrolledHeartbeatAgentIds(cfg: OpenClawConfig): ReadonlySet<string> {
  return new Set(resolveHeartbeatAgentIds(cfg));
}

export function isEnrolledHeartbeatAgent(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  enrolled: ReadonlySet<string>,
): boolean {
  const resolvedAgentId = agentId ?? tryResolveAmbientHeartbeatAgentId(cfg);
  return resolvedAgentId !== undefined && enrolled.has(normalizeAgentId(resolvedAgentId));
}

export function buildHeartbeatSummary(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  enrolled: ReadonlySet<string>,
): HeartbeatSummary {
  const merged = resolveHeartbeatConfig(cfg, agentId);
  const everyMs = resolveHeartbeatIntervalMs(cfg, undefined, merged);
  const enabled = isEnrolledHeartbeatAgent(cfg, agentId, enrolled) && everyMs !== null;

  return {
    enabled,
    every: enabled ? (merged?.every ?? DEFAULT_HEARTBEAT_EVERY) : "disabled",
    everyMs: enabled ? everyMs : null,
    prompt: resolveHeartbeatPromptText(merged?.prompt),
    target: merged?.target ?? DEFAULT_HEARTBEAT_TARGET,
    model: merged?.model,
    session: merged?.session,
    ackMaxChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  };
}
