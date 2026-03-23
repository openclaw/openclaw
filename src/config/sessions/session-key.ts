import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionScope } from "./types.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { normalizeE164 } from "../../utils.js";
import { resolveGroupSessionKey } from "./group.js";

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

export function canonicalizeSessionKeyForAgent(params: {
  sessionKey: string;
  agentId?: string;
  mainKey?: string;
}) {
  const raw = params.sessionKey.trim().toLowerCase();
  if (!raw) {
    return raw;
  }
  if (raw === "global" || raw === "unknown") {
    return raw;
  }
  if (raw.startsWith("agent:")) {
    return raw;
  }
  const resolvedAgentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  const canonicalMainKey = normalizeMainKey(params.mainKey);
  if (raw === "main" || raw === canonicalMainKey) {
    return buildAgentMainSessionKey({
      agentId: resolvedAgentId,
      mainKey: canonicalMainKey,
    });
  }
  return `agent:${resolvedAgentId}:${raw}`;
}

export function resolveSessionKeyForAgent(
  scope: SessionScope,
  ctx: MsgContext,
  mainKey?: string,
  agentId?: string,
) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) {
    return canonicalizeSessionKeyForAgent({
      sessionKey: explicit,
      agentId,
      mainKey,
    });
  }
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") {
    return raw;
  }
  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) {
    return canonicalizeSessionKeyForAgent({
      sessionKey: normalizeMainKey(mainKey),
      agentId,
      mainKey,
    });
  }
  return canonicalizeSessionKeyForAgent({
    sessionKey: raw,
    agentId,
    mainKey,
  });
}

export function resolveSessionKey(
  scope: SessionScope,
  ctx: MsgContext,
  mainKey?: string,
  agentId?: string,
) {
  return resolveSessionKeyForAgent(scope, ctx, mainKey, agentId);
}
