/** Resolves runtime policy session keys distinct from transcript session keys. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildAgentMainSessionKey,
  buildAgentPeerSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { resolveSessionEntryChatType } from "../../sessions/session-chat-type-shared.js";
import { resolveLongTermMemoryTargetChatType } from "../../sessions/session-memory-policy.js";
import type { MsgContext } from "../templating.js";

type RuntimePolicyContext = Pick<
  MsgContext,
  | "AccountId"
  | "ChatType"
  | "CommandTargetSessionKey"
  | "From"
  | "NativeDirectUserId"
  | "OriginatingChannel"
  | "OriginatingTo"
  | "Provider"
  | "RuntimePolicySessionKey"
  | "SenderE164"
  | "SenderId"
  | "SenderUsername"
  | "SessionKey"
  | "Surface"
  | "To"
>;

type TargetChatTypeContext = Pick<MsgContext, "ChatType">;
type TargetSessionContext = Pick<MsgContext, "CommandTargetSessionKey" | "SessionKey">;

export function shouldPreferSessionEntryForTargetSession(params: {
  ctx?: TargetSessionContext;
  sessionKey?: string | null;
}): boolean {
  const targetSessionKey = normalizeOptionalString(params.sessionKey);
  const currentSessionKey = normalizeOptionalString(params.ctx?.SessionKey);
  if (!targetSessionKey) {
    return false;
  }
  if (!currentSessionKey) {
    return true;
  }
  if (targetSessionKey === currentSessionKey) {
    return false;
  }
  const commandTargetSessionKey = normalizeOptionalString(params.ctx?.CommandTargetSessionKey);
  return !commandTargetSessionKey || commandTargetSessionKey === targetSessionKey;
}

/** Resolves chat type for the target session, not merely the command source. */
export function resolveTargetSessionChatType(params: {
  ctx?: TargetChatTypeContext;
  sessionEntry?: Pick<SessionEntry, "chatType" | "origin" | "route" | "longTermMemoryDefaultPolicy">;
  sessionKey?: string | null;
  preferSessionEntry?: boolean;
}): ChatType | undefined {
  const live = normalizeChatType(params.ctx?.ChatType);
  return resolveLongTermMemoryTargetChatType({
    sessionKey: params.sessionKey,
    liveChatType: live,
    storedChatType: resolveSessionEntryChatType(params.sessionEntry),
    longTermMemoryDefaultPolicy: params.sessionEntry?.longTermMemoryDefaultPolicy,
    preferStoredPolicy: params.preferSessionEntry,
  });
}

function resolvePolicyChannel(ctx?: RuntimePolicyContext): string | undefined {
  const raw = normalizeOptionalString(ctx?.OriginatingChannel ?? ctx?.Provider ?? ctx?.Surface);
  if (!raw) {
    return undefined;
  }
  const channel = normalizeLowercaseStringOrEmpty(raw);
  return channel && channel !== "webchat" ? channel : undefined;
}

function resolvePolicyDirectPeerId(ctx?: RuntimePolicyContext): string | undefined {
  return normalizeOptionalString(
    ctx?.NativeDirectUserId ??
      ctx?.SenderId ??
      ctx?.SenderE164 ??
      ctx?.SenderUsername ??
      ctx?.OriginatingTo ??
      ctx?.From ??
      ctx?.To,
  );
}

function isMainSessionAlias(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): boolean {
  const raw = normalizeLowercaseStringOrEmpty(params.sessionKey);
  if (!raw) {
    return false;
  }
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
  const agentMainSessionKey = buildAgentMainSessionKey({
    agentId,
    mainKey,
  });
  const agentMainAliasKey = buildAgentMainSessionKey({
    agentId,
    mainKey: "main",
  });
  return (
    raw === "main" ||
    raw === mainKey ||
    raw === agentMainSessionKey ||
    raw === agentMainAliasKey ||
    raw === buildAgentMainSessionKey({ agentId: "main", mainKey }) ||
    raw === buildAgentMainSessionKey({ agentId: "main", mainKey: "main" }) ||
    (params.cfg?.session?.scope === "global" && raw === "global")
  );
}

/** Resolves the session key used for runtime policy checks and direct-message scoping. */
/** Resolves the session key used for sandbox/tool/runtime policy lookups. */
export function resolveRuntimePolicySessionKey(params: {
  cfg?: OpenClawConfig;
  ctx?: RuntimePolicyContext;
  sessionKey?: string | null;
}): string | undefined {
  const explicitPolicySessionKey = normalizeOptionalString(params.ctx?.RuntimePolicySessionKey);
  if (explicitPolicySessionKey) {
    return explicitPolicySessionKey;
  }
  const sessionKey = normalizeOptionalString(
    params.sessionKey ?? params.ctx?.CommandTargetSessionKey ?? params.ctx?.SessionKey,
  );
  if (!sessionKey) {
    return undefined;
  }

  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  if (!isMainSessionAlias({ cfg: params.cfg, agentId, sessionKey })) {
    return sessionKey;
  }

  if (normalizeChatType(params.ctx?.ChatType) !== "direct") {
    return sessionKey;
  }
  const channel = resolvePolicyChannel(params.ctx);
  const peerId = resolvePolicyDirectPeerId(params.ctx);
  if (!channel || !peerId) {
    return sessionKey;
  }

  // Direct main-session replies use a peer-scoped key so policy does not leak across DMs.
  return buildAgentPeerSessionKey({
    agentId,
    channel,
    accountId: params.ctx?.AccountId,
    peerKind: "direct",
    peerId,
    dmScope: "per-account-channel-peer",
    identityLinks: params.cfg?.session?.identityLinks,
  });
}
