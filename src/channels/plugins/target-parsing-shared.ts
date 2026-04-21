import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "../../shared/string-coerce.js";
import type { ChatType } from "../chat-type.js";
import type { ChannelMessagingAdapter } from "./types.core.js";

export type ParsedChannelExplicitTarget = {
  to: string;
  threadId?: string | number;
  chatType?: ChatType;
};

export type ComparableChannelTarget = {
  rawTo: string;
  to: string;
  threadId?: string | number;
  chatType?: ParsedChannelExplicitTarget["chatType"];
};

export type ChannelTargetParsingMessaging = Pick<
  ChannelMessagingAdapter,
  "normalizeTarget" | "parseExplicitTarget" | "resolveSessionTarget"
>;

export function resolveParsedChannelTarget(params: {
  rawTarget: string;
  messaging?: ChannelTargetParsingMessaging | null;
}): {
  normalizedTarget: string;
  parsedTarget: ParsedChannelExplicitTarget | null;
} {
  try {
    const normalizedTarget =
      params.messaging?.normalizeTarget?.(params.rawTarget) ?? params.rawTarget;
    return {
      normalizedTarget,
      parsedTarget: params.messaging?.parseExplicitTarget?.({ raw: normalizedTarget }) ?? null,
    };
  } catch {
    return {
      normalizedTarget: params.rawTarget,
      parsedTarget: null,
    };
  }
}

export function resolveComparableChannelTarget(params: {
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
  messaging?: ChannelTargetParsingMessaging | null;
}): ComparableChannelTarget | null {
  const rawTo = normalizeOptionalString(params.rawTarget);
  if (!rawTo) {
    return null;
  }
  const { parsedTarget } = resolveParsedChannelTarget({
    rawTarget: rawTo,
    messaging: params.messaging,
  });
  const fallbackThreadId = normalizeOptionalThreadValue(params.fallbackThreadId);
  return {
    rawTo,
    to: parsedTarget?.to ?? rawTo,
    threadId: normalizeOptionalThreadValue(parsedTarget?.threadId ?? fallbackThreadId),
    chatType: parsedTarget?.chatType,
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

export function resolveCurrentChannelTargetFromMessaging(params: {
  rawTarget?: string | null;
  threadId?: string | number | null;
  messaging?: ChannelTargetParsingMessaging | null;
}): string | undefined {
  const rawTarget = normalizeOptionalString(params.rawTarget);
  if (!rawTarget) {
    return undefined;
  }
  if (params.threadId == null || !params.messaging) {
    return rawTarget;
  }
  const { normalizedTarget, parsedTarget } = resolveParsedChannelTarget({
    rawTarget,
    messaging: params.messaging,
  });
  if (!parsedTarget) {
    return normalizedTarget;
  }
  if (
    parsedTarget.threadId != null ||
    parsedTarget.chatType === "direct" ||
    parsedTarget.chatType == null
  ) {
    return normalizedTarget;
  }
  const sessionKind = parsedTarget.chatType;
  return (
    params.messaging.resolveSessionTarget?.({
      kind: sessionKind,
      id: parsedTarget?.to ?? normalizedTarget,
      threadId: String(params.threadId),
    }) ?? normalizedTarget
  );
}
