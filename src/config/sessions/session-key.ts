import type { MsgContext } from "../../auto-reply/templating.js";
import {
  buildAgentMainSessionKey,
  normalizeMainKey,
  normalizeAgentId,
} from "../../routing/session-key.js";
import { normalizeE164 } from "../../utils.js";
import type { OpenClawConfig } from "../config.js";
import { normalizeExplicitSessionKey } from "./explicit-session-key-normalization.js";
import { resolveGroupSessionKey } from "./group.js";
import type { SessionScope } from "./types.js";

const FALLBACK_DEFAULT_AGENT_ID = "main";

/**
 * Inline derivation of the default agent id from config (avoids cross-layer import).
 * Mirrors the logic in main-session.ts and agent-scope.ts::resolveDefaultAgentId.
 */
function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents = cfg?.agents?.list ?? [];
  if (agents.length === 0) {
    return FALLBACK_DEFAULT_AGENT_ID;
  }
  const defaults = agents.filter((a) => a?.default);
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || FALLBACK_DEFAULT_AGENT_ID);
}

// Decide which session bucket to use (per-sender vs global).
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
  if (scope === "global") {
    return "global";
  }
  const resolvedGroup = resolveGroupSessionKey(ctx);
  if (resolvedGroup) {
    return resolvedGroup.key;
  }
  const from = ctx.From ? normalizeE164(ctx.From) : "";
  return from || "unknown";
}

/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
export function resolveSessionKey(
  scope: SessionScope,
  ctx: MsgContext,
  mainKey?: string,
  cfg?: OpenClawConfig,
) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) {
    return normalizeExplicitSessionKey(explicit, ctx);
  }
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") {
    return raw;
  }
  const defaultAgentId = resolveDefaultAgentId(cfg ?? {});
  const canonicalMainKey = normalizeMainKey(mainKey);
  const canonical = buildAgentMainSessionKey({
    agentId: defaultAgentId,
    mainKey: canonicalMainKey,
  });
  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) {
    return canonical;
  }
  return canonicalizeGroupSessionKey({ cfg, sessionKey: `agent:${defaultAgentId}:${raw}` });
}

/**
 * Canonicalize a group session key, handling migration from the old format
 * (raw group key like "provider:group:id") to the new agent-scoped format
 * ("agent:{agentId}:provider:group:id").
 *
 * Mirrors the migration pattern of canonicalizeMainSessionAlias for direct-chat keys.
 */
export function canonicalizeGroupSessionKey(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
}): string {
  const raw = params.sessionKey.trim();
  if (!raw) {
    return raw;
  }

  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) {
    return raw;
  }

  // Already in agent-scoped format — return as-is.
  if (raw.startsWith("agent:")) {
    return raw;
  }

  // Old format: "{provider}:{group|channel}:{id}" → "agent:{defaultAgentId}:{provider}:{group|channel}:{id}"
  const defaultAgentId = resolveDefaultAgentId(params.cfg ?? {});
  return `agent:${defaultAgentId}:${raw}`;
}
