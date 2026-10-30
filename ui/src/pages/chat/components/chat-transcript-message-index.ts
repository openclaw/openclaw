import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { nativeHistoryMessageIdentity } from "../../../lib/chat/history-message-identity.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import {
  agentRunFrameActiveStatusParts,
  chatItemGroups,
  coalesceAgentRunFrames,
} from "../chat-agent-run-grouping.ts";
import { assistantGroupCanOwnActiveRunStatus } from "../chat-assistant-reply.ts";
import { isHandoffBoundaryItem } from "../chat-sessions-yield.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { coalesceSystemEvents } from "../chat-system-event-grouping.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import {
  type buildCachedChatItems,
  findLiveStreamIndex,
  getExpansionStateVersion,
  getChatItemsGeneration,
  setExpansionState,
} from "../chat-thread.ts";
import { isInterSessionMessage, isSessionActivityGroup } from "../chat-turn-boundary.ts";
import {
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
} from "../chat-turn-presentation.ts";
import { readLiveTerminalRevision } from "../terminal-message-identity.ts";
import { prepareChatStreamRender } from "./chat-message-markdown-view.tsx";
import { resolveMessageGroupSenderLabel } from "./chat-message-sender.ts";
import type { StreamGroupPart } from "./chat-message-stream-view.tsx";
import {
  isVisibleChatStream,
  projectChatPositions,
  type ChatPositionIndex,
} from "./chat-position-projection.ts";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";
import type { projectTranscriptWorkPreviews } from "./chat-transcript-work-previews.ts";

type ChatRenderItem = SystemEventRenderItem;

type TranscriptChain = Readonly<{
  searchActive: boolean;
  workGroups: readonly Extract<ChatRenderItem, { kind: "work-group" }>[];
  collapsedItems: readonly ChatRenderItem[];
  transcriptItems: readonly ChatRenderItem[];
  /** Active status parts shown inside the preceding reply, keyed by that reply's group. */
  continuations: ReadonlyMap<string, StreamGroupPart[]>;
  /** The mounted bubble resolves current text independently of these structural rows. */
  live?: LiveOwner;
}>;

type TranscriptIndex = Readonly<{
  messageRowKeysById: ReadonlyMap<string, string>;
  transcriptMessageKeys: ReadonlyMap<string, string>;
  loadedReplySources: ReadonlyMap<string, LoadedReplySource>;
  positionIndex: ChatPositionIndex;
  rows: readonly TranscriptRow<ChatRenderItem>[];
  liveItem?: StreamOwner;
}>;

type TranscriptIndexSource = Pick<
  TranscriptChain,
  "searchActive" | "transcriptItems" | "continuations" | "live"
>;

type LiveStream = Extract<ReturnType<typeof buildCachedChatItems>[number], { kind: "stream" }>;
type StreamOwner = Extract<ChatRenderItem, { kind: "stream-run" | "agent-run-frame" }>;
type LiveOwner = Readonly<{
  message: unknown;
  item: StreamOwner;
  transcriptIndex: number;
}>;
type ChainEntry = {
  key: readonly unknown[];
  value: TranscriptChain;
};

// Text belongs to the mounted bubble; only structural inputs and visibility
// invalidate the chain and its immutable indexes.
const chains = new WeakMap<object, ChainEntry>();
const indexes = createTranscriptMemo<TranscriptIndex>();
const presentationRows = createTranscriptMemo<readonly TranscriptRow<ChatRenderItem>[]>();

// Fold only the final presentation, after causal run/turn ownership is settled.
// Every original message and its reply identity remains in chronological order.
function coalesceInterSessionUpdates(items: ChatRenderItem[]): ChatRenderItem[] {
  const result: ChatRenderItem[] = [];
  let pending: MessageGroup[] = [];
  const flush = () => {
    const first = pending[0];
    if (first) {
      result.push(
        pending.length === 1
          ? first
          : {
              ...first,
              runId: undefined,
              messages: pending.flatMap((group) => group.messages),
              visibleContent: pending.some((group) => group.visibleContent === "non-text")
                ? "non-text"
                : pending.some((group) => group.visibleContent === "text")
                  ? "text"
                  : "none",
            },
      );
    }
    pending = [];
  };
  for (const item of items) {
    if (
      item.kind !== "group" ||
      !isSessionActivityGroup(item) ||
      // Automation runs stay separate even when they target the same conversation.
      !isInterSessionMessage(item.messages[0]?.message) ||
      !item.senderSession?.sessionKey ||
      // Reply targets retain the original group's run and prompt attribution.
      item.messages.some(({ message }) => normalizeMessage(message).replyTarget)
    ) {
      flush();
      result.push(item);
      continue;
    }
    const first = pending[0];
    if (
      first &&
      (first.senderSession?.sessionKey !== item.senderSession.sessionKey ||
        first.senderSession?.agentId !== item.senderSession.agentId ||
        first.senderSession?.label !== item.senderSession.label)
    ) {
      flush();
    }
    pending.push(item);
  }
  flush();
  return result;
}

function ownsStream(item: ChatRenderItem, stream: LiveStream): item is StreamOwner {
  return item.kind === "stream-run"
    ? item.parts.includes(stream)
    : item.kind === "agent-run-frame" &&
        item.parts.some((part) => part.kind === "stream-run" && part.parts.includes(stream));
}

export function projectTranscriptChain(
  chatItems: ReturnType<typeof buildCachedChatItems>,
  options: {
    sessionKey: string;
    runWorking: boolean;
    searchActive: boolean;
    bubbleMode?: boolean;
    messages?: readonly unknown[];
    activeRunId?: string | null;
  },
): TranscriptChain {
  const liveIndex = findLiveStreamIndex(chatItems);
  const liveStream = chatItems[liveIndex];
  const key = [
    liveStream?.kind === "stream" && isVisibleChatStream(liveStream),
    getChatItemsGeneration(chatItems),
    options.sessionKey,
    options.runWorking,
    options.searchActive,
    options.bubbleMode,
    options.messages,
    options.activeRunId,
    readLiveTerminalRevision(),
  ];
  const cached = chains.get(chatItems);
  if (cached?.key.every((value, index) => Object.is(value, key[index]))) {
    return cached.value;
  }
  const frames = coalesceAgentRunFrames(
    coalesceActivityRuns(
      collapseCompletedTurnWork(coalesceStreamRuns(chatItems), options),
      options,
    ),
    options,
  );
  const collapsedItems = options.searchActive
    ? frames
    : coalesceSystemEvents(coalesceInterSessionUpdates(frames));
  const continuations = new Map<string, StreamGroupPart[]>();
  const transcriptItems = collapsedItems.filter((item, index) => {
    // A handoff boundary only shapes the grouping above; it has no row of its own.
    if (isHandoffBoundaryItem(item)) {
      return false;
    }
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
  let liveOwner: LiveOwner | undefined;
  if (liveStream?.kind === "stream") {
    const owner = collapsedItems.findLast((candidate): candidate is StreamOwner =>
      ownsStream(candidate, liveStream),
    );
    const transcriptIndex = owner ? transcriptItems.lastIndexOf(owner) : -1;
    liveOwner =
      owner && transcriptIndex >= 0
        ? {
            message: prepareChatStreamRender(liveStream).message,
            item: owner,
            transcriptIndex,
          }
        : undefined;
  }
  const value: TranscriptChain = {
    collapsedItems,
    transcriptItems,
    workGroups: transcriptItems.filter((candidate) => candidate.kind === "work-group"),
    continuations,
    searchActive: options.searchActive,
    live: liveOwner,
  };
  chains.set(chatItems, { key, value });
  return value;
}

export function projectTranscriptIndex(
  chain: TranscriptIndexSource,
  expandedToolCards: Map<string, boolean>,
  props: Pick<ChatThreadProps, "assistantName" | "userId" | "userName" | "messageReactions">,
): TranscriptIndex {
  const cacheKey = [
    expandedToolCards,
    getExpansionStateVersion(expandedToolCards),
    props.assistantName,
    props.userId,
    props.userName,
    props.messageReactions,
  ];
  return indexes(chain, cacheKey, (): TranscriptIndex => {
    const loadedReplySources = new Map<string, LoadedReplySource>();
    const messageRowKeysById = new Map<string, string>();
    const transcriptMessageKeys = new Map<string, string>();
    const rows: TranscriptRow<ChatRenderItem>[] = [];
    const row = (item: ChatRenderItem, key = item.key): TranscriptRow<ChatRenderItem> => {
      const groups = chatItemGroups(item);
      const parts = item.kind === "agent-run-frame" ? item.parts : [item];
      if (
        chain.continuations.has(item.key) ||
        (item.kind === "agent-run-frame" && item.outcome.kind === "active") ||
        groups.some((group) => group.isStreaming) ||
        parts.some(
          (part) =>
            part.kind === "stream-run" ||
            part.kind === "stream" ||
            part.kind === "reading-indicator",
        )
      ) {
        return { kind: "item", key, item };
      }
      const messages = groups.flatMap((group) =>
        group.messages.map(({ message }) => [
          nativeHistoryMessageIdentity(message) ?? message,
          props.messageReactions?.get(persistedMessageEntryId(message) ?? "") ?? [],
        ]),
      );
      const content = JSON.stringify(
        item.kind === "agent-run-frame"
          ? [item.outcome.kind, messages]
          : messages.length
            ? messages
            : item,
      );
      return { kind: "item", key, item, revision: `${content.length}:${fnv1aUtf16(content)}` };
    };
    for (const item of chain.transcriptItems) {
      rows.push(row(item));
      if (item.kind === "work-group" && expandedToolCards.get(item.key)) {
        for (const group of item.groups) {
          rows.push(row(group, `${item.key}:${group.key}`));
        }
      }
      const parts = item.kind === "agent-run-frame" ? item.parts : [item];
      const groups = chatItemGroups(item);
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
        for (const group of chatItemGroups(part)) {
          const senderLabel = resolveMessageGroupSenderLabel(firstGroup ?? group, props);
          const rowKey =
            item.kind === "work-group" && expandedToolCards.get(item.key)
              ? item.key + ":" + group.key
              : item.key;
          for (const source of group.messages) {
            transcriptMessageKeys.set(source.key, rowKey);
            const sourceMessageId = persistedMessageEntryId(source.message);
            if (sourceMessageId) {
              // Split fragments share a persisted ID. Prefer a visible anchor and
              // resolve actions against the original recorded envelope.
              const previous = loadedReplySources.get(sourceMessageId);
              if (!previous || source.hasVisibleContent) {
                messageRowKeysById.set(sourceMessageId, rowKey);
                loadedReplySources.set(sourceMessageId, {
                  message: source.actionMessage ?? source.message,
                  messageId: source.actionKey ?? source.key,
                  senderLabel,
                });
              }
            }
          }
        }
      }
    }
    const positionIndex = projectChatPositions(
      chain.transcriptItems,
      expandedToolCards,
      messageRowKeysById,
      chain.searchActive,
    );
    return {
      messageRowKeysById,
      transcriptMessageKeys,
      loadedReplySources,
      positionIndex,
      rows,
      liveItem: chain.live?.item,
    };
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
        part.kind === "group" &&
        isSessionActivityGroup(part) &&
        part.messages.some((source) => persistedMessageEntryId(source.message) === messageId)
      ) {
        setExpansionState(expandedToolCards, "session-activity:" + part.key, true);
      }
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

export type PlacedContentRow = Extract<TranscriptRow, { kind: "content" }> & {
  /** Row key this content follows; null leads the transcript and undefined trails it. */
  after?: string | null;
};

export function projectTranscriptRows(
  rows: readonly TranscriptRow<ChatRenderItem>[],
  workPreviews: ReturnType<typeof projectTranscriptWorkPreviews>,
  contentRows: readonly PlacedContentRow[],
): readonly TranscriptRow<ChatRenderItem>[] {
  const key = [workPreviews, ...contentRows.flatMap((row) => [row.key, row.after])];
  return presentationRows(rows, key, () => {
    if (!workPreviews.size && !contentRows.length) {
      return rows;
    }
    const placed = Map.groupBy(
      contentRows.filter((row) => row.after !== undefined),
      (row) => row.after,
    );
    const take = (after: string | null) => {
      const found = placed.get(after) ?? [];
      placed.delete(after);
      return found;
    };
    const result: TranscriptRow<ChatRenderItem>[] = take(null);
    for (const row of rows) {
      result.push(row);
      const previews = workPreviews.get(row.key);
      if (previews && !(row.kind === "item" && row.item.kind === "work-group")) {
        const content: NativeTranscriptView = { kind: "work-previews", previews };
        result.push({
          kind: "content",
          key: `work-previews:${row.key}`,
          content: new GuardedTranscriptItem([content], content),
        });
      }
      result.push(...take(row.key));
    }
    // An anchor outside these rows keeps its content visible at the end.
    return result.concat(
      [...placed.values()].flat(),
      contentRows.filter((row) => row.after === undefined),
    );
  });
}
