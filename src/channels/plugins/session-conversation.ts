import { parseTelegramTopicConversation } from "../../acp/conversation-id.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
  type ParsedThreadSessionSuffix,
  type RawSessionConversationRef,
} from "../../sessions/session-key-utils.js";
import { normalizeChannelId as normalizeChatChannelId } from "../registry.js";
import { getChannelPlugin, normalizeChannelId as normalizeAnyChannelId } from "./registry.js";

export type ResolvedSessionConversation = {
  id: string;
  threadId: string | undefined;
  parentConversationCandidates: string[];
};

export type ResolvedSessionConversationRef = {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  id: string;
  threadId: string | undefined;
  baseSessionKey: string;
  parentConversationCandidates: string[];
};

type SessionConversationHookResult = {
  id: string;
  threadId?: string | null;
  parentConversationCandidates?: string[];
};

type NormalizedSessionConversationResolution = ResolvedSessionConversation & {
  hasExplicitParentConversationCandidates: boolean;
};

function normalizeResolvedChannel(channel: string): string {
  return (
    normalizeAnyChannelId(channel) ??
    normalizeChatChannelId(channel) ??
    channel.trim().toLowerCase()
  );
}

function getMessagingAdapter(channel: string) {
  const normalizedChannel = normalizeResolvedChannel(channel);
  try {
    return getChannelPlugin(normalizedChannel)?.messaging;
  } catch {
    return undefined;
  }
}

function dedupeConversationIds(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    resolved.push(trimmed);
  }
  return resolved;
}

function buildGenericConversationResolution(rawId: string): ResolvedSessionConversation | null {
  const trimmed = rawId.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseThreadSessionSuffix(trimmed);
  const id = (parsed.baseSessionKey ?? trimmed).trim();
  if (!id) {
    return null;
  }

  return {
    id,
    threadId: parsed.threadId,
    parentConversationCandidates: dedupeConversationIds(
      parsed.threadId ? [parsed.baseSessionKey] : [],
    ),
  };
}

function normalizeSessionConversationResolution(
  resolved: SessionConversationHookResult | null | undefined,
): NormalizedSessionConversationResolution | null {
  if (!resolved?.id?.trim()) {
    return null;
  }

  return {
    id: resolved.id.trim(),
    threadId: resolved.threadId?.trim() || undefined,
    parentConversationCandidates: dedupeConversationIds(
      resolved.parentConversationCandidates ?? [],
    ),
    hasExplicitParentConversationCandidates: Object.hasOwn(
      resolved,
      "parentConversationCandidates",
    ),
  };
}

function resolveBundledSessionConversationFallback(params: {
  channel: string;
  rawId: string;
}): NormalizedSessionConversationResolution | null {
  if (normalizeResolvedChannel(params.channel) !== "telegram") {
    return null;
  }

  const parsed = parseTelegramTopicConversation({ conversationId: params.rawId });
  if (!parsed) {
    return null;
  }

  return {
    id: parsed.chatId,
    threadId: parsed.topicId,
    parentConversationCandidates: [parsed.chatId],
    hasExplicitParentConversationCandidates: true,
  };
}

function resolveSessionConversationResolution(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
}): ResolvedSessionConversation | null {
  const rawId = params.rawId.trim();
  if (!rawId) {
    return null;
  }

  const messaging = getMessagingAdapter(params.channel);
  const pluginResolved = normalizeSessionConversationResolution(
    messaging?.resolveSessionConversation?.({
      kind: params.kind,
      rawId,
    }),
  );
  const resolved =
    pluginResolved ??
    resolveBundledSessionConversationFallback({
      channel: params.channel,
      rawId,
    }) ??
    buildGenericConversationResolution(rawId);
  if (!resolved) {
    return null;
  }

  const parentConversationCandidates = dedupeConversationIds(
    pluginResolved?.hasExplicitParentConversationCandidates
      ? resolved.parentConversationCandidates
      : (messaging?.resolveParentConversationCandidates?.({
          kind: params.kind,
          rawId,
        }) ?? resolved.parentConversationCandidates),
  );

  return {
    ...resolved,
    parentConversationCandidates,
  };
}

export function resolveSessionConversation(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
}): ResolvedSessionConversation | null {
  return resolveSessionConversationResolution(params);
}

function buildBaseSessionKey(raw: RawSessionConversationRef, id: string): string {
  return `${raw.prefix}:${id}`;
}

export function resolveSessionConversationRef(
  sessionKey: string | undefined | null,
): ResolvedSessionConversationRef | null {
  const raw = parseRawSessionConversationRef(sessionKey);
  if (!raw) {
    return null;
  }

  const resolved = resolveSessionConversation(raw);
  if (!resolved) {
    return null;
  }

  return {
    channel: normalizeResolvedChannel(raw.channel),
    kind: raw.kind,
    rawId: raw.rawId,
    id: resolved.id,
    threadId: resolved.threadId,
    baseSessionKey: buildBaseSessionKey(raw, resolved.id),
    parentConversationCandidates: resolved.parentConversationCandidates,
  };
}

export function resolveSessionThreadInfo(
  sessionKey: string | undefined | null,
): ParsedThreadSessionSuffix {
  const resolved = resolveSessionConversationRef(sessionKey);
  if (!resolved) {
    return parseThreadSessionSuffix(sessionKey);
  }

  return {
    baseSessionKey: resolved.threadId ? resolved.baseSessionKey : sessionKey?.trim() || undefined,
    threadId: resolved.threadId,
  };
}

export function resolveSessionParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  const { baseSessionKey, threadId } = resolveSessionThreadInfo(sessionKey);
  if (!threadId) {
    return null;
  }
  return baseSessionKey ?? null;
}
