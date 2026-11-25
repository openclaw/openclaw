import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { streamSegmentHasItemId, type ChatStreamSegment } from "../../lib/chat/chat-types.ts";

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
  const segments = state.chatStreamSegments?.filter(
    (segment) =>
      !state.chatRunId || segment.runId !== state.chatRunId || streamSegmentHasItemId(segment),
  );
  // An unchanged history refresh must not invalidate the full transcript projection.
  if (segments?.length !== state.chatStreamSegments?.length) {
    state.chatStreamSegments = segments;
  }
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

function inputBelongsToRun(message: unknown, runId: string) {
  const identity = readSessionMessageIdentity(message);
  return (
    identity?.role === "user" &&
    (identity.runId === runId || persistedSteerTargetRunId(message) === runId)
  );
}

/** Live activity keeps the input boundary seen on arrival, independent of clocks. */
export function observedRunInputSendId(
  messages: unknown[] | undefined,
  runId: string,
): string | undefined {
  const input = messages?.findLast((message) => inputBelongsToRun(message, runId));
  return readSessionMessageIdentity(input)?.sendId ?? undefined;
}

export function knownStreamCausalInterval(
  messages: unknown[],
  runId?: string,
  afterUserSendId?: string,
): { start: number; end: number } | null {
  const inputIndex = afterUserSendId
    ? messages.findIndex(
        (message) => readSessionMessageIdentity(message)?.sendId === afterUserSendId,
      )
    : -1;
  const startIndex =
    inputIndex >= 0
      ? inputIndex
      : runId
        ? messages.findIndex((message) => inputBelongsToRun(message, runId))
        : -1;
  if (
    afterUserSendId &&
    inputIndex < 0 &&
    startIndex >= 0 &&
    persistedSteerTargetRunId(messages[startIndex]) === runId
  ) {
    // The observed input fell off the loaded page. Its live activity predates
    // the first retained steer; an unanchored replay or tail does not.
    return { start: 0, end: startIndex };
  }
  const runOutputIndex =
    startIndex < 0 && runId
      ? messages.findIndex((message) => readSessionMessageIdentity(message)?.runId === runId)
      : -1;
  if (startIndex >= 0 || runOutputIndex >= 0 || afterUserSendId) {
    const start = startIndex >= 0 ? startIndex + 1 : Math.max(runOutputIndex, 0);
    const end = messages.findIndex(
      (message, index) =>
        index >= start &&
        readSessionMessageIdentity(message)?.role === "user" &&
        (inputIndex >= 0 || persistedSteerTargetRunId(message) !== runId),
    );
    return { start, end: end >= 0 ? end : messages.length };
  }
  return null;
}

export function streamCausalInterval(
  messages: unknown[],
  runId?: string,
  afterUserSendId?: string,
): { start: number; end: number } {
  return (
    knownStreamCausalInterval(messages, runId, afterUserSendId) ?? {
      start: lastUserMessageIndex(messages) + 1,
      end: messages.length,
    }
  );
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

/** Keep a durable cumulative prefix hidden until its terminal or next tail arrives. */
export function retainPersistedStreamPrefix(
  host: StreamRolloverState,
  text = host.chatStream,
): void {
  if (text?.trim() && host.chatRunId) {
    host.chatStreamSegments = [
      ...(host.chatStreamSegments ?? []),
      {
        text,
        ts: host.chatStreamStartedAt ?? Date.now(),
        runId: host.chatRunId,
        persisted: true,
      },
    ];
  }
  if (text === host.chatStream) {
    host.chatStream = null;
    host.chatStreamStartedAt = null;
  }
}
