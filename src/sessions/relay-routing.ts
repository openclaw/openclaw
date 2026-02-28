import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig, SessionRelayRoutingMode } from "../config/config.js";
import type { SessionChatType, SessionEntry } from "../config/sessions.js";
import { deriveSessionChatType } from "./session-key-utils.js";

export type SessionRelayOutputTarget = {
  targetKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export type SessionRelaySourceMetadata = {
  channel?: string;
  chatType?: SessionChatType;
  sessionKey?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type SessionRelayRoute = {
  mode: SessionRelayRoutingMode;
  source: SessionRelaySourceMetadata;
  output?: SessionRelayOutputTarget;
  matchedRuleIndex?: number;
};

function normalizeRelayMode(raw?: string | null): SessionRelayRoutingMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "read-write") {
    return "read-write";
  }
  if (value === "read-only") {
    return "read-only";
  }
  return undefined;
}

function normalizeMatchValue(raw?: string | null) {
  const value = raw?.trim().toLowerCase();
  return value ? value : undefined;
}

function normalizeNonEmpty(raw?: string | null): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function stripAgentSessionKeyPrefix(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  const parts = key.split(":").filter(Boolean);
  // Canonical agent session keys: agent:<agentId>:<sessionKey...>
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }
  return key;
}

function deriveChannelFromKey(key?: string) {
  const normalizedKey = stripAgentSessionKeyPrefix(key);
  if (!normalizedKey) {
    return undefined;
  }
  const parts = normalizedKey.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return normalizeMatchValue(parts[0]);
  }
  return undefined;
}

function deriveChatTypeFromKey(key?: string): SessionChatType | undefined {
  const chatType = deriveSessionChatType(key);
  return chatType === "unknown" ? undefined : chatType;
}

function normalizeRelayTarget(
  key: string,
  target:
    | {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
      }
    | undefined,
): SessionRelayOutputTarget | undefined {
  const channel = normalizeNonEmpty(target?.channel)?.toLowerCase();
  const to = normalizeNonEmpty(target?.to);
  if (!channel || !to) {
    return undefined;
  }
  return {
    targetKey: key,
    channel,
    to,
    accountId: normalizeNonEmpty(target?.accountId),
    threadId: target?.threadId,
  };
}

function resolveDefaultReadOnlyTarget(cfg: OpenClawConfig): SessionRelayOutputTarget | undefined {
  const targets = cfg.session?.relayRouting?.targets;
  if (!targets) {
    return undefined;
  }
  const normalizedTargets = Object.entries(targets)
    .map(([key, target]) => normalizeRelayTarget(key, target))
    .filter(Boolean) as SessionRelayOutputTarget[];
  if (normalizedTargets.length !== 1) {
    return undefined;
  }
  return normalizedTargets[0];
}

export function resolveSessionRelayRoute(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  channel?: string;
  chatType?: SessionChatType;
  sourceTo?: string;
  sourceAccountId?: string;
  sourceThreadId?: string | number;
}): SessionRelayRoute {
  const channel = normalizeMatchValue(params.channel) ?? deriveChannelFromKey(params.sessionKey);
  const chatType =
    normalizeChatType(params.chatType ?? params.entry?.chatType) ??
    normalizeChatType(deriveChatTypeFromKey(params.sessionKey));
  const rawSessionKey = params.sessionKey ?? "";
  const strippedSessionKey = stripAgentSessionKeyPrefix(rawSessionKey) ?? "";
  const rawSessionKeyNorm = rawSessionKey.toLowerCase();
  const strippedSessionKeyNorm = strippedSessionKey.toLowerCase();
  const source: SessionRelaySourceMetadata = {
    channel,
    chatType,
    sessionKey: params.sessionKey,
    to: normalizeNonEmpty(params.sourceTo),
    accountId: normalizeNonEmpty(params.sourceAccountId),
    threadId: params.sourceThreadId,
  };

  const relayCfg = params.cfg.session?.relayRouting;
  if (!relayCfg) {
    return { mode: "read-write", source };
  }

  for (const [index, rule] of (relayCfg.rules ?? []).entries()) {
    if (!rule) {
      continue;
    }
    const mode = normalizeRelayMode(rule.mode);
    if (!mode) {
      continue;
    }
    const match = rule.match ?? {};
    const matchChannel = normalizeMatchValue(match.channel);
    const matchChatType = normalizeChatType(match.chatType);
    const matchPrefix = normalizeMatchValue(match.keyPrefix);
    const matchRawPrefix = normalizeMatchValue(match.rawKeyPrefix);

    if (matchChannel && matchChannel !== channel) {
      continue;
    }
    if (matchChatType && matchChatType !== chatType) {
      continue;
    }
    if (matchRawPrefix && !rawSessionKeyNorm.startsWith(matchRawPrefix)) {
      continue;
    }
    if (
      matchPrefix &&
      !rawSessionKeyNorm.startsWith(matchPrefix) &&
      !strippedSessionKeyNorm.startsWith(matchPrefix)
    ) {
      continue;
    }

    if (mode === "read-write") {
      return { mode: "read-write", source, matchedRuleIndex: index };
    }
    const relayToKey = normalizeNonEmpty(rule.relayTo);
    const target = relayToKey
      ? normalizeRelayTarget(relayToKey, relayCfg.targets?.[relayToKey])
      : undefined;
    if (!target) {
      continue;
    }
    return {
      mode: "read-only",
      source,
      output: target,
      matchedRuleIndex: index,
    };
  }

  const defaultMode = normalizeRelayMode(relayCfg.defaultMode) ?? "read-write";
  if (defaultMode === "read-only") {
    const target = resolveDefaultReadOnlyTarget(params.cfg);
    if (target) {
      return { mode: "read-only", source, output: target };
    }
  }
  return { mode: "read-write", source };
}
