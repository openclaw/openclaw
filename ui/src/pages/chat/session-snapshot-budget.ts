import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import { nativeHistoryMessageSourceIdentity } from "../../lib/chat/history-message-identity.ts";
import { serializedMessageArrayWeight } from "../../lib/chat/message-weight.ts";
import {
  CHAT_ROW_DISPLAY_WINDOW,
  projectChatRowDisplay,
} from "../../lib/chat/row-display-facts.ts";
import {
  trimmedChatHistoryPagination,
  type ChatHistoryPagination,
} from "./chat-history-pagination.ts";
import type { ChatSessionSnapshot } from "./session-snapshot-contract.ts";

// JSON code-unit weight bounds retained payloads without allocating another
// UTF-8 buffer on the route-switch path.
export const MAX_CACHED_CHAT_SNAPSHOT_WEIGHT = 12 * 1024 * 1024;
export const MAX_CACHED_CHAT_WEIGHT = 24 * 1024 * 1024;
export type CachedChatSessionSnapshot = {
  snapshot: ChatSessionSnapshot;
  weight: number;
};

export function boundChatSessionSnapshot(
  snapshot: ChatSessionSnapshot,
): CachedChatSessionSnapshot | null {
  const messageWeights: number[] = [];
  for (const message of snapshot.messages) {
    const weight = serializedArrayItemWeight(message);
    if (weight === null) {
      return null;
    }
    messageWeights.push(weight);
  }
  let retainedMessageWeight = messageWeights.reduce((sum, weight) => sum + weight, 0);
  let start = 0;
  // Before the display window, only loss of the intrinsic source changes the
  // trimmed envelope. Prepare both canonical variants instead of rescanning each cut.
  const lastIntrinsicIndex = snapshot.pagination.intrinsicSource
    ? snapshot.messages.findLastIndex(
        (message) =>
          nativeHistoryMessageSourceIdentity(message) === snapshot.pagination.intrinsicSource,
      )
    : -1;
  const trimmedPagination = trimmedChatHistoryPagination(snapshot.pagination, snapshot.messages, 1);
  const trimmedWithoutIntrinsic = trimmedChatHistoryPagination(
    snapshot.pagination,
    snapshot.messages,
    snapshot.messages.length,
  );
  const lastSharedTrim = snapshot.messages.length - CHAT_ROW_DISPLAY_WINDOW;
  let sharedEnvelope:
    | {
        pagination: ChatHistoryPagination;
        measured: ReturnType<typeof measureChatSnapshotEnvelope>;
      }
    | undefined;
  while (true) {
    if (start > 0 && start === snapshot.messages.length) {
      return null;
    }
    const pagination =
      start === 0
        ? snapshot.pagination
        : start <= lastIntrinsicIndex
          ? trimmedPagination
          : trimmedWithoutIntrinsic;
    const shared = start > 0 && start <= lastSharedTrim;
    const envelope =
      (shared && sharedEnvelope?.pagination === pagination && sharedEnvelope.measured) ||
      measureChatSnapshotEnvelope(snapshot, start, pagination);
    if (shared) {
      sharedEnvelope = { pagination, measured: envelope };
    }
    const { rowDisplay } = envelope;
    const weight =
      envelope.weight === null
        ? null
        : envelope.weight + retainedMessageWeight + Math.max(0, messageWeights.length - start - 1);
    if (weight !== null && weight <= MAX_CACHED_CHAT_SNAPSHOT_WEIGHT) {
      return {
        snapshot:
          start === 0 && rowDisplay === snapshot.rowDisplay
            ? snapshot
            : {
                ...snapshot,
                rowDisplay,
                ...(start > 0
                  ? { messages: snapshot.messages.slice(start), pagination: { ...pagination } }
                  : {}),
              },
        weight,
      };
    }
    if (start >= snapshot.messages.length) {
      return null;
    }
    const boundarySeq = readSessionMessageSequence(snapshot.messages[start]);
    do {
      retainedMessageWeight -= messageWeights[start] ?? 0;
      start += 1;
      if (boundarySeq === null) {
        break;
      }
    } while (
      start < snapshot.messages.length &&
      readSessionMessageSequence(snapshot.messages[start]) === boundarySeq
    );
  }
}

function measureChatSnapshotEnvelope(
  snapshot: ChatSessionSnapshot,
  start: number,
  pagination: ChatHistoryPagination,
) {
  const rowDisplay = projectChatRowDisplay(snapshot, start);
  try {
    const envelope = { ...snapshot, messages: [], rowDisplay, pagination };
    return { rowDisplay, weight: JSON.stringify(envelope)?.length ?? 0 };
  } catch {
    return { rowDisplay, weight: null };
  }
}

export function serializedArrayItemWeight(value: unknown): number | null {
  try {
    return Math.max(0, serializedMessageArrayWeight(value) - 2);
  } catch {
    return null;
  }
}
