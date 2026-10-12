import type { GatewaySessionRow } from "../../../api/types.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { agentRunFrameActiveStatusParts, chatItemGroups } from "../chat-agent-run-grouping.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  type buildCachedChatItems,
  coalesceActivityRuns,
  coalesceAgentRunFrames,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  findLiveStreamIndex,
  getExpansionStateVersion,
  getChatItemsGeneration,
  persistedMessageEntryId,
  setExpansionState,
} from "../chat-thread.ts";
import { isInterSessionMessage, isSessionActivityGroup } from "../chat-turn-boundary.ts";
import { readLiveTerminalRevision } from "../terminal-message-identity.ts";
import { resolveMessageGroupSenderLabel } from "./chat-message-sender.ts";
import type { StreamGroupPart } from "./chat-message-stream.ts";
import { projectChatPositions, type ChatPositionIndex } from "./chat-position-projection.ts";
import type { LoadedReplySource } from "./chat-reply-preview.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";

type ChatRenderItem = ReturnType<typeof coalesceAgentRunFrames>[number];

type TranscriptChain = {
  searchActive: boolean;
  workGroups: readonly Extract<ChatRenderItem, { kind: "work-group" }>[];
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

type TranscriptIndexSource = Pick<TranscriptChain, "searchActive" | "transcriptItems">;

type LiveStream = Extract<ReturnType<typeof buildCachedChatItems>[number], { kind: "stream" }>;
type StreamOwner = Extract<ChatRenderItem, { kind: "stream-run" | "agent-run-frame" }>;
type LiveOwner = {
  item: StreamOwner;
  collapsedIndex: number;
  transcriptIndex: number;
};
type LiveSlot = {
  index: number;
  item: LiveStream;
  owner?: LiveOwner;
};
type LiveProjection = {
  item: LiveStream;
  owner: LiveOwner;
  structuralChain: TranscriptChain;
};
type ChainEntry = {
  key: readonly unknown[];
  value: TranscriptChain;
  structuralChain: TranscriptChain;
  live?: LiveSlot;
};
type BaseIndex = {
  chain: TranscriptIndexSource;
  index: TranscriptIndex;
  ownerRowIndex: number;
};

// Structural inputs and terminal outcomes invalidate the full projection. A live
// slot replacement derives immutable tail updates from that structural entry.
const chains = new WeakMap<object, ChainEntry>();
const liveChains = new WeakMap<TranscriptIndexSource, LiveProjection>();
const indexes = createTranscriptMemo<TranscriptIndex>();
const baseIndexes = createTranscriptMemo<BaseIndex>();

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

function sameStreamStructure(previous: LiveStream, next: LiveStream): boolean {
  const structural = (field: PropertyKey) => field !== "text" && field !== "thinking";
  const fields = Reflect.ownKeys(previous).filter(structural);
  return (
    fields.length === Reflect.ownKeys(next).filter(structural).length &&
    fields.every(
      (field) =>
        Object.hasOwn(next, field) &&
        Object.is(Reflect.get(previous, field), Reflect.get(next, field)),
    )
  );
}

function replaceOwnerStream(
  owner: StreamOwner,
  previous: LiveStream,
  next: LiveStream,
): StreamOwner {
  const replace = (run: Extract<StreamOwner, { kind: "stream-run" }>) => ({
    ...run,
    parts: run.parts.map((part) => (part === previous ? next : part)),
  });
  return owner.kind === "stream-run"
    ? replace(owner)
    : {
        ...owner,
        parts: owner.parts.map((part) =>
          part.kind === "stream-run" && part.parts.includes(previous) ? replace(part) : part,
        ),
      };
}

export function projectTranscriptChain(
  chatItems: ReturnType<typeof buildCachedChatItems>,
  options: {
    sessionKey: string;
    runWorking: boolean;
    searchActive: boolean;
    bubbleMode?: boolean;
    session?: Pick<GatewaySessionRow, "key" | "lastRunId" | "status" | "runtimeMs">;
  },
): TranscriptChain {
  const { session } = options;
  const key = [
    getChatItemsGeneration(chatItems),
    options.sessionKey,
    options.runWorking,
    options.searchActive,
    options.bubbleMode,
    session?.key,
    session?.lastRunId,
    session?.status,
    session?.runtimeMs,
    readLiveTerminalRevision(),
  ];
  const cached = chains.get(chatItems);
  if (cached?.key.every((value, index) => Object.is(value, key[index]))) {
    const live = cached.live;
    if (!live || chatItems[live.index] === live.item) {
      return cached.value;
    }
    const next = chatItems[live.index];
    if (live.owner && next?.kind === "stream" && sameStreamStructure(live.item, next)) {
      // Text cannot change grouping or status continuations; only its containing
      // wrappers change. Previously handed-off chains remain untouched: array
      // slices are memcpy-cheap, unlike rebuilding history or copying Maps.
      const owner = replaceOwnerStream(live.owner.item, live.item, next);
      const collapsedItems = cached.value.collapsedItems.slice();
      const transcriptItems = cached.value.transcriptItems.slice();
      collapsedItems[live.owner.collapsedIndex] = owner;
      transcriptItems[live.owner.transcriptIndex] = owner;
      const value = { ...cached.value, collapsedItems, transcriptItems };
      const updatedOwner = { ...live.owner, item: owner };
      const updatedLive = { ...live, item: next, owner: updatedOwner };
      liveChains.set(value, {
        item: next,
        owner: updatedOwner,
        structuralChain: cached.structuralChain,
      });
      chains.set(chatItems, { ...cached, value, live: updatedLive });
      return value;
    }
  }
  const frames = coalesceAgentRunFrames(
    coalesceActivityRuns(
      collapseCompletedTurnWork(coalesceStreamRuns(chatItems), options),
      options,
    ),
    options,
  );
  const collapsedItems = options.searchActive ? frames : coalesceInterSessionUpdates(frames);
  const continuations = new Map<string, StreamGroupPart[]>();
  const transcriptItems = collapsedItems.filter((item, index) => {
    // A handoff boundary only shapes the grouping above; it has no row of its own.
    if (item.kind === "notice" && item.handoffBoundary) {
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
  const value = {
    collapsedItems,
    transcriptItems,
    workGroups: transcriptItems.filter((item) => item.kind === "work-group"),
    continuations,
    searchActive: options.searchActive,
  };
  const index = findLiveStreamIndex(chatItems);
  const item = chatItems[index];
  let live: LiveSlot | undefined;
  if (item?.kind === "stream") {
    const owner = value.collapsedItems.findLast((candidate): candidate is StreamOwner =>
      ownsStream(candidate, item),
    );
    const transcriptIndex = owner ? value.transcriptItems.lastIndexOf(owner) : -1;
    const projection =
      owner && transcriptIndex >= 0
        ? {
            item: owner,
            collapsedIndex: value.collapsedItems.lastIndexOf(owner),
            transcriptIndex,
          }
        : undefined;
    live = { index, item, owner: projection };
    if (projection) {
      liveChains.set(value, { item, owner: projection, structuralChain: value });
    }
  }
  chains.set(chatItems, { key, value, structuralChain: value, live });
  return value;
}

export function projectTranscriptIndex(
  chain: TranscriptIndexSource,
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
  return indexes(chain, key, () => {
    const live = liveChains.get(chain);
    if (!live) {
      return buildTranscriptIndex(chain, expandedToolCards, props);
    }
    const tail = projectChatPositions(
      chain.transcriptItems.slice(live.owner.transcriptIndex),
      expandedToolCards,
      new Map(),
      chain.searchActive,
    );
    const visible = tail.markerIdsByMessageId.has(live.item.key);
    const base = baseIndexes(live.structuralChain, [...key, visible], () => {
      const index = buildTranscriptIndex(chain, expandedToolCards, props);
      const ownerRowIndex = index.rows.findLastIndex((row) => row.key === live.owner.item.key);
      if (ownerRowIndex < 0) {
        throw new Error("Missing live stream owner row");
      }
      return { chain, index, ownerRowIndex };
    });
    if (base.chain === chain) {
      return base.index;
    }
    const rows = base.index.rows.slice();
    rows[base.ownerRowIndex] = { kind: "item", key: live.owner.item.key, item: live.owner.item };
    let markers = base.index.positionIndex.markers;
    for (const marker of tail.markers) {
      const markerIndex = base.index.positionIndex.markers.findLastIndex(
        (candidate) => candidate.id === marker.id,
      );
      if (markerIndex < 0) {
        continue;
      }
      const baseMarker = base.index.positionIndex.markers[markerIndex]!;
      if (marker.message !== baseMarker.message) {
        if (markers === base.index.positionIndex.markers) {
          markers = markers.slice();
        }
        markers[markerIndex] = { ...baseMarker, message: marker.message };
      }
    }
    // These finished Maps are text-independent within one visibility state.
    // Reusing them avoids copying history and preserves the consumer handoff.
    return { ...base.index, rows, positionIndex: { ...base.index.positionIndex, markers } };
  });
}

function buildTranscriptIndex(
  chain: TranscriptIndexSource,
  expandedToolCards: Map<string, boolean>,
  props: Pick<ChatThreadProps, "assistantName" | "userId" | "userName">,
): TranscriptIndex {
  const loadedReplySources = new Map<string, LoadedReplySource>();
  const messageRowKeysById = new Map<string, string>();
  const transcriptMessageKeys = new Map<string, string>();
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
  const positionIndex = projectChatPositions(
    chain.transcriptItems,
    expandedToolCards,
    messageRowKeysById,
    chain.searchActive,
  );
  return { messageRowKeysById, transcriptMessageKeys, loadedReplySources, positionIndex, rows };
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
