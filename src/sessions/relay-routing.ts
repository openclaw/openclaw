import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig, SessionRelayRoutingConfig } from "../config/config.js";
import { parseAgentSessionKey } from "./session-key-utils.js";

export type RelayRoutingMode = "read-write" | "read-only";

export type RelayRouteSource = {
  channel?: string;
  chatType?: ChatType;
  sessionKey?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type RelayRouteTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

export type RelayRouteResolution =
  | {
      mode: "read-write";
      source: RelayRouteSource;
    }
  | {
      mode: "read-only";
      target: RelayRouteTarget;
      source: RelayRouteSource;
    };

function normalizeMatchValue(raw?: string | null) {
  const value = raw?.trim().toLowerCase();
  return value ? value : undefined;
}

function normalizeRelayRoutingMode(raw?: string | null): RelayRoutingMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "read-write") {
    return "read-write";
  }
  if (value === "read-only") {
    return "read-only";
  }
  return undefined;
}

function stripAgentSessionKeyPrefix(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  return parseAgentSessionKey(key)?.rest ?? key;
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

function resolveRelayTarget(
  routing: SessionRelayRoutingConfig,
  relayTo: string | undefined,
): RelayRouteTarget | undefined {
  if (!relayTo || !relayTo.trim()) {
    return undefined;
  }
  const target = routing.targets?.[relayTo];
  if (!target) {
    return undefined;
  }
  return {
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
  };
}

function resolveDefaultReadOnlyTarget(
  routing: SessionRelayRoutingConfig,
): RelayRouteTarget | undefined {
  const entries = Object.entries(routing.targets ?? {});
  if (entries.length !== 1) {
    return undefined;
  }
  const [, target] = entries[0];
  return {
    channel: target.channel,
    to: target.to,
    accountId: target.accountId,
    threadId: target.threadId,
  };
}

/**
 * Resolve session relay-routing mode and optional relay target using live inbound context.
 */
export function resolveSessionRelayRoute(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  channel?: string;
  chatType?: string;
  source?: {
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
}): RelayRouteResolution {
  const routing = params.cfg.session?.relayRouting;
  const channel =
    normalizeMatchValue(params.channel) ?? deriveChannelFromKey(params.sessionKey ?? undefined);
  const chatType = normalizeChatType(params.chatType);
  const rawSessionKey = params.sessionKey ?? "";
  const strippedSessionKey = stripAgentSessionKeyPrefix(rawSessionKey) ?? "";
  const rawSessionKeyNorm = rawSessionKey.toLowerCase();
  const strippedSessionKeyNorm = strippedSessionKey.toLowerCase();
  const source: RelayRouteSource = {
    channel,
    chatType,
    sessionKey: params.sessionKey,
    to: params.source?.to,
    accountId: params.source?.accountId,
    threadId: params.source?.threadId,
  };

  if (!routing) {
    return { mode: "read-write", source };
  }

  for (const rule of routing.rules ?? []) {
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
    if (matchPrefix && !strippedSessionKeyNorm.startsWith(matchPrefix)) {
      continue;
    }

    const mode = normalizeRelayRoutingMode(rule.mode) ?? "read-write";
    if (mode === "read-only") {
      const target = resolveRelayTarget(routing, rule.relayTo);
      if (target) {
        return { mode: "read-only", target, source };
      }
      return { mode: "read-write", source };
    }
    return { mode: "read-write", source };
  }

  const defaultMode = normalizeRelayRoutingMode(routing.defaultMode) ?? "read-write";
  if (defaultMode === "read-only") {
    const target = resolveDefaultReadOnlyTarget(routing);
    if (target) {
      return { mode: "read-only", target, source };
    }
  }
  return { mode: "read-write", source };
}
