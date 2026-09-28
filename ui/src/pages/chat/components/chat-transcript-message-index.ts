import type { GatewaySessionRow } from "../../../api/types.ts";
import { agentRunFrameActiveStatusParts } from "../chat-agent-run-grouping.ts";
import {
  agentRunFrameGroups,
  assistantGroupCanOwnActiveRunStatus,
  type buildCachedChatItems,
  coalesceActivityRuns,
  coalesceAgentRunFrames,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  getExpansionStateVersion,
  persistedMessageEntryId,
  setExpansionState,
} from "../chat-thread.ts";
import { readLiveTerminalRevision } from "../terminal-message-identity.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-group.ts";
import type { StreamGroupPart } from "./chat-message.ts";
import { projectChatPositions, type ChatPositionIndex } from "./chat-position-projection.ts";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

type TranscriptChain = {
  collapsedItems: readonly ChatRenderItem[];
  transcriptItems: readonly ChatRenderItem[];
  /** Active status parts shown inside the preceding reply, keyed by that reply's group. */
  continuations: ReadonlyMap<string, StreamGroupPart[]>;
};

type TranscriptIndex = {
  messageRowKeysById: ReadonlyMap<string, string>;
  transcriptMessageKeys: ReadonlyMap<string, string>;
  loadedReplySources: ReadonlyMap<string, LoadedReplySource>;
  positionIndex: ChatPositionIndex;
  rows: readonly TranscriptRow<ChatRenderItem>[];
};

// Scroll-driven renders reuse the cached chat items. Everything below derives
// from them plus the live stream text patched into them in place, and live
// terminal outcomes recorded beside them, so those join each cache key.
const chains = new WeakMap<object, { key: readonly unknown[]; value: TranscriptChain }>();
const indexes = new WeakMap<object, { key: readonly unknown[]; value: TranscriptIndex }>();

function memoize<T>(
  cache: WeakMap<object, { key: readonly unknown[]; value: T }>,
  owner: object,
  key: readonly unknown[],
  build: () => T,
): T {
  const cached = cache.get(owner);
  if (cached?.key.every((value, index) => Object.is(value, key[index]))) {
    return cached.value;
  }
  const value = build();
  cache.set(owner, { key, value });
  return value;
}

export function projectTranscriptChain(
  chatItems: ReturnType<typeof buildCachedChatItems>,
  options: {
    sessionKey: string;
    runWorking: boolean;
    searchActive: boolean;
    session?: Pick<GatewaySessionRow, "key" | "lastRunId" | "status" | "runtimeMs">;
    stream: string | null;
  },
): TranscriptChain {
  const { session } = options;
  const key = [
    options.sessionKey,
    options.runWorking,
    options.searchActive,
    options.stream,
    session?.key,
    session?.lastRunId,
    session?.status,
    session?.runtimeMs,
    readLiveTerminalRevision(),
  ];
  return memoize(chains, chatItems, key, () => {
    const collapsedItems = coalesceAgentRunFrames(
      coalesceActivityRuns(
        collapseCompletedTurnWork(coalesceStreamRuns(chatItems), options),
        options,
      ),
      options,
    );
    const continuations = new Map<string, StreamGroupPart[]>();
    const transcriptItems = collapsedItems.filter((item, index) => {
      const previous = collapsedItems[index - 1];
      const activeStatusParts =
        item.kind === "stream-run" && item.parts.every((part) => part.kind === "reading-indicator")
          ? item.parts
          : item.kind === "agent-run-frame"
            ? agentRunFrameActiveStatusParts(item)
            : undefined;
      const activeStatusRunId =
        item.kind === "stream-run" || item.kind === "agent-run-frame" ? item.runId : undefined;
      if (
        previous?.kind !== "group" ||
        !activeStatusParts ||
        !assistantGroupCanOwnActiveRunStatus(previous) ||
        (previous.runId !== undefined &&
          activeStatusRunId !== undefined &&
          previous.runId !== activeStatusRunId)
      ) {
        return true;
      }
      // A reply and its still-running state are one turn-level presentation.
      // Keeping the status in the reply avoids a second claw/assistant row.
      continuations.set(previous.key, activeStatusParts);
      return false;
    });
    return { collapsedItems, transcriptItems, continuations };
  });
}

export function projectTranscriptIndex(
  chain: TranscriptChain,
  expandedToolCards: Map<string, boolean>,
  props: Pick<ChatThreadProps, "assistantName" | "userId" | "userName">,
): TranscriptIndex {
  const key = [
    expandedToolCards,
    getExpansionStateVersion(expandedToolCards),
    props.assistantName,
    props.userId,
    props.userName,
  ];
  return memoize(indexes, chain, key, () => {
    const loadedReplySources = new Map<string, LoadedReplySource>();
    const { messageRowKeysById, transcriptMessageKeys } = projectTranscriptMessageIndex(
      chain.transcriptItems,
      expandedToolCards,
      props,
      loadedReplySources,
    );
    const positionIndex = projectChatPositions(
      chain.transcriptItems,
      expandedToolCards,
      messageRowKeysById,
    );
    // New row keys measure expanded work immediately; existing keys keep their
    // cached height until ResizeObserver reports the changed layout.
    const rows: TranscriptRow<ChatRenderItem>[] = [];
    for (const item of chain.transcriptItems) {
      rows.push({ kind: "item", key: item.key, item });
      if (item.kind === "work-group" && expandedToolCards.get(item.key)) {
        for (const group of item.groups) {
          rows.push({ kind: "item", key: `${item.key}:${group.key}`, item: group });
        }
      }
    }
    return { messageRowKeysById, transcriptMessageKeys, loadedReplySources, positionIndex, rows };
  });
}

export function expandReplyTargetWork(
  transcriptItems: readonly ChatRenderItem[],
  expandedToolCards: Map<string, boolean>,
  messageId: string,
): void {
  for (const item of transcriptItems) {
    const parts = item.kind === "agent-run-frame" ? item.parts : [item];
    for (const part of parts) {
      if (
        part.kind === "work-group" &&
        part.groups.some((group) =>
          group.messages.some((source) => persistedMessageEntryId(source.message) === messageId),
        )
      ) {
        setExpansionState(expandedToolCards, part.key, true);
      }
    }
  }
}

function projectTranscriptMessageIndex(
  transcriptItems: readonly ChatRenderItem[],
  expandedToolCards: ReadonlyMap<string, boolean>,
  props: Pick<ChatThreadProps, "assistantName" | "userId" | "userName">,
  loadedReplySources: Map<string, LoadedReplySource>,
) {
  const messageRowKeysById = new Map<string, string>();
  const transcriptMessageKeys = new Map<string, string>();
  for (const item of transcriptItems) {
    const parts = item.kind === "agent-run-frame" ? item.parts : [item];
    const groups =
      item.kind === "agent-run-frame"
        ? agentRunFrameGroups(item)
        : item.kind === "group"
          ? [item]
          : item.kind === "work-group" || item.kind === "activity-run"
            ? item.groups
            : [];
    const firstGroup = groups.find((group) => group.role === "assistant") ?? groups[0];
    // The anchor owner uses the first key, so keep stream and persisted keys
    // in their actual presentation order, including within a mixed run frame.
    for (const part of parts) {
      if (part.kind === "stream-run") {
        for (const stream of part.parts) {
          if (stream.kind === "stream") {
            transcriptMessageKeys.set(stream.key, item.key);
          }
        }
      } else if (part.kind === "stream") {
        transcriptMessageKeys.set(part.key, item.key);
      }
      const partGroups =
        part.kind === "group"
          ? [part]
          : part.kind === "work-group" || part.kind === "activity-run"
            ? part.groups
            : [];
      for (const group of partGroups) {
        const senderLabel = resolveMessageGroupSenderLabel(firstGroup ?? group, {
          assistantName: props.assistantName,
          userId: props.userId,
          userName: props.userName,
        });
        const rowKey =
          item.kind === "work-group" && expandedToolCards.get(item.key)
            ? item.key + ":" + group.key
            : item.key;
        for (const source of group.messages) {
          transcriptMessageKeys.set(source.key, rowKey);
          const sourceMessageId = persistedMessageEntryId(source.message);
          if (sourceMessageId) {
            messageRowKeysById.set(sourceMessageId, rowKey);
            loadedReplySources.set(sourceMessageId, {
              message: source.message,
              messageId: source.key,
              senderLabel,
            });
          }
        }
      }
    }
  }
  return { messageRowKeysById, transcriptMessageKeys };
}
