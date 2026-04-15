import type { MsgContext } from "../../auto-reply/templating.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { resolveSessionRoute } from "../../routing/resolve-route.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { normalizeE164 } from "../../utils.js";
import { normalizeExplicitSessionKey } from "./explicit-session-key-normalization.js";
import { resolveGroupSessionKey } from "./group.js";
import type { SessionScope } from "./types.js";

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

function buildRouteActorFromCtx(
  ctx: MsgContext,
  groupResolution: ReturnType<typeof resolveGroupSessionKey> | null,
) {
  const provider = normalizeMessageChannel(
    ctx.Surface || ctx.Provider || normalizeLowercaseStringOrEmpty(ctx.From).split(":", 1)[0],
  );
  const chatType =
    groupResolution?.chatType ??
    (normalizeOptionalLowercaseString(ctx.ChatType) === "group"
      ? "group"
      : normalizeOptionalLowercaseString(ctx.ChatType) === "channel"
        ? "channel"
        : "direct");
  return {
    provider: provider || "api",
    accountId: ctx.AccountId,
    from: ctx.From,
    to: typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To,
    chatType,
  };
}

/**
 * Resolve the session key with a canonical direct-chat bucket (default: "main").
 * All non-group direct chats collapse to this bucket; groups stay isolated.
 */
export function resolveSessionKey(scope: SessionScope, ctx: MsgContext, mainKey?: string) {
  const explicit = ctx.SessionKey?.trim();
  const normalizedMainKey = normalizeMainKey(mainKey);
  const groupResolution = resolveGroupSessionKey(ctx);
  if (scope === "global") {
    return "global";
  }
  if (groupResolution) {
    return `agent:${DEFAULT_AGENT_ID}:${groupResolution.key}`;
  }
  return (
    resolveSessionRoute({
      agentId: DEFAULT_AGENT_ID,
      surface: normalizeMessageChannel(ctx.Surface || ctx.Provider) || "api",
      rawSessionInput: explicit ? normalizeExplicitSessionKey(explicit, ctx) : undefined,
      sessionScope: "agent",
      mainKey: normalizedMainKey,
      actor: buildRouteActorFromCtx(ctx, groupResolution),
    }).sessionKey ??
    buildAgentMainSessionKey({
      agentId: DEFAULT_AGENT_ID,
      mainKey: normalizedMainKey,
    })
  );
}
