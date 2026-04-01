import type { ChatType } from "../chat-type.js";
import { normalizeChatChannelId } from "../registry.js";
import { getChannelPlugin, normalizeChannelId } from "./registry.js";

export type ParsedChannelExplicitTarget = {
  to: string;
  threadId?: string | number;
  chatType?: ChatType;
};

export type ComparableChannelTarget = {
  rawTo: string;
  to: string;
  threadId?: string | number;
  chatType?: ChatType;
};

function normalizeComparableThreadId(
  threadId?: string | number | null,
): string | number | undefined {
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
  }
  if (typeof threadId !== "string") {
    return undefined;
  }
  const trimmed = threadId.trim();
  return trimmed ? trimmed : undefined;
}

function parseWithPlugin(
  rawChannel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  const channel = normalizeChatChannelId(rawChannel) ?? normalizeChannelId(rawChannel);
  if (!channel) {
    return null;
  }
  return getChannelPlugin(channel)?.messaging?.parseExplicitTarget?.({ raw: rawTarget }) ?? null;
}

export function parseExplicitTargetForChannel(
  channel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  return parseWithPlugin(channel, rawTarget);
}

export function resolveComparableTargetForChannel(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ComparableChannelTarget | null {
  const rawTo = params.rawTarget?.trim();
  if (!rawTo) {
    return null;
  }
  const parsed = parseExplicitTargetForChannel(params.channel, rawTo);
  const fallbackThreadId = normalizeComparableThreadId(params.fallbackThreadId);
  return {
    rawTo,
    to: parsed?.to ?? rawTo,
    threadId: normalizeComparableThreadId(parsed?.threadId ?? fallbackThreadId),
    chatType: parsed?.chatType,
  };
}

export function comparableChannelTargetsMatch(params: {
  left?: ComparableChannelTarget | null;
  right?: ComparableChannelTarget | null;
}): boolean {
  const left = params.left;
  const right = params.right;
  if (!left || !right) {
    return false;
  }
  return left.to === right.to && left.threadId === right.threadId;
}

export function comparableChannelTargetsShareRoute(params: {
  left?: ComparableChannelTarget | null;
  right?: ComparableChannelTarget | null;
}): boolean {
  const left = params.left;
  const right = params.right;
  if (!left || !right) {
    return false;
  }
  if (left.to !== right.to) {
    return false;
  }
  if (left.threadId == null || right.threadId == null) {
    return true;
  }
  return left.threadId === right.threadId;
}
