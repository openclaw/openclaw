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

type SessionConversationResolution = ResolvedSessionConversation;

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

function resolveSessionConversationResolution(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
}): SessionConversationResolution | null {
  const rawId = params.rawId.trim();
  if (!rawId) {
    return null;
  }

  const messaging = getMessagingAdapter(params.channel);
  const pluginResolved = messaging?.resolveSessionConversation?.({
    kind: params.kind,
    rawId,
  });
  const resolved =
    pluginResolved && pluginResolved.id?.trim()
      ? {
          id: pluginResolved.id.trim(),
          threadId: pluginResolved.threadId?.trim() || undefined,
          parentConversationCandidates: dedupeConversationIds(
            pluginResolved.parentConversationCandidates ?? [],
          ),
        }
      : buildGenericConversationResolution(rawId);
  if (!resolved) {
    return null;
  }

  const parentConversationCandidates = dedupeConversationIds(
    messaging?.resolveParentConversationCandidates?.({
      kind: params.kind,
      rawId,
    }) ?? resolved.parentConversationCandidates,
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

export function resolveParentConversationCandidates(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
}): string[] {
  return resolveSessionConversationResolution(params)?.parentConversationCandidates ?? [];
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
