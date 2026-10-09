import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { streamSegmentHasItemId, type ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import { userTurnRunId } from "./chat-thread-items.ts";

export type StreamCausalBoundaryState = {
  chatMessages?: unknown[];
  chatRunId?: string | null;
  chatStreamSegments?: ChatStreamSegment[];
};

type StreamRolloverState = {
  chatMessages?: unknown[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatStreamSegments?: ChatStreamSegment[];
};

/** A replacement changes cumulative coordinates while preserving independent items and ordering. */
export function replaceChatStream(
  state: Pick<StreamRolloverState, "chatRunId" | "chatStream" | "chatStreamSegments">,
  text: string | null,
): void {
  state.chatStreamSegments = state.chatStreamSegments?.flatMap<ChatStreamSegment>((segment) => {
    if (!state.chatRunId || segment.runId !== state.chatRunId || streamSegmentHasItemId(segment)) {
      return [segment];
    }
    return [];
  });
  state.chatStream = text;
}

export function lastUserMessageIndex(messages: unknown[], beforeIndex = messages.length): number {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (normalizeLowercaseStringOrEmpty(asNullableRecord(messages[index])?.role) === "user") {
      return index;
    }
  }
  return -1;
}

export function persistedSteerTargetRunId(message: unknown): string | null {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  return normalizeOptionalString(metadata?.steerTargetRunId) ?? null;
}

export function streamCausalInterval(
  messages: unknown[],
  part: { runId?: string },
): { start: number; end: number } {
  const startIndex = part.runId
    ? messages.findIndex((message) => userTurnRunId(message) === part.runId)
    : -1;
  if (startIndex >= 0) {
    const end = messages.findIndex(
      (message, index) =>
        index > startIndex &&
        readSessionMessageIdentity(message)?.role === "user" &&
        persistedSteerTargetRunId(message) !== part.runId,
    );
    return { start: startIndex + 1, end: end >= 0 ? end : messages.length };
  }
  const end = messages.length;
  return { start: lastUserMessageIndex(messages, end) + 1, end };
}

export function streamCausalInsertIndex(
  messages: unknown[],
  desiredTimestamp: number,
  startIndex: number,
  endIndex: number,
  readTimestamp: (message: unknown) => number | null,
): number {
  for (let index = startIndex; index < endIndex; index++) {
    const timestamp = readTimestamp(messages[index]);
    if (timestamp != null && timestamp > desiredTimestamp) {
      return index;
    }
  }
  return endIndex;
}

export function resolveAssistantTextTail(
  persistedTexts: readonly (string | null)[],
  cumulativeText: string,
): string | null {
  let persistedPrefixLength = 0;
  for (const persistedText of persistedTexts) {
    if (!persistedText) {
      continue;
    }
    const remaining = cumulativeText.slice(persistedPrefixLength);
    if (remaining.startsWith(persistedText)) {
      persistedPrefixLength += persistedText.length;
      continue;
    }
    if (persistedText.startsWith(remaining)) {
      return null;
    }
    const whitespace = persistedPrefixLength > 0 ? /^\s+/u.exec(remaining)?.[0] : undefined;
    if (whitespace && remaining.slice(whitespace.length).startsWith(persistedText)) {
      persistedPrefixLength += whitespace.length + persistedText.length;
      continue;
    }
    if (whitespace && persistedText.startsWith(remaining.slice(whitespace.length))) {
      return null;
    }
    if (persistedPrefixLength > 0) {
      break;
    }
  }
  return cumulativeText.slice(persistedPrefixLength);
}

/** Keep a durable cumulative prefix hidden until its terminal or next tail arrives. */
export function retainPersistedStreamPrefix(host: StreamRolloverState): void {
  if (host.chatStream?.trim() && host.chatRunId) {
    host.chatStreamSegments = [
      ...(host.chatStreamSegments ?? []),
      {
        text: host.chatStream,
        ts: host.chatStreamStartedAt ?? Date.now(),
        runId: host.chatRunId,
        persisted: true,
      },
    ];
  }
  host.chatStream = null;
  host.chatStreamStartedAt = null;
}
