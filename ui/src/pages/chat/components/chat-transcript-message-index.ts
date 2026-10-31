import type { GatewaySessionRow } from "../../../api/types.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { nativeHistoryMessageIdentity } from "../../../lib/chat/history-message-identity.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import {
  agentRunFrameActiveStatusParts,
  chatItemGroups,
  coalesceAgentRunFrames,
  type AgentRunFrameRenderItem,
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
import { CHAT_TRANSCRIPT_ESTIMATED_ROW_PX } from "./chat-transcript-session.ts";
import type { projectTranscriptWorkPreviews } from "./chat-transcript-work-previews.ts";

type ChatRenderItem = SystemEventRenderItem;
const COMPLETED_FRAME_ROW_MESSAGE_LIMIT = 1;

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
const rowRevisions = createTranscriptMemo<string>();
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
    session?: Pick<GatewaySessionRow, "key" | "lastRunId" | "status" | "runtimeMs">;
  },
): TranscriptChain {
  const { session } = options;
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
    session?.key,
    session?.lastRunId,
    session?.status,
    session?.runtimeMs,
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
    workGroups: transcriptItems.flatMap((candidate) =>
      candidate.kind === "agent-run-frame"
        ? candidate.parts.filter((part) => part.kind === "work-group")
        : candidate.kind === "work-group"
          ? [candidate]
          : [],
    ),
    continuations,
    searchActive: options.searchActive,
    live: liveOwner,
  };
  chains.set(chatItems, { key, value });
  return value;
}

// Approximate the visible blocks without parsing offscreen Markdown. Actual
// border-box measurements replace these hints in the virtualizer's size cache.
function estimateMessageGroupSize(group: MessageGroup): number | undefined {
  if (group.role !== "user" && group.role !== "assistant") {
    return undefined;
  }
  let size = 72;
  for (const source of group.messages) {
    for (const part of normalizeMessage(source.message).content) {
      if (part.type === "image") {
        size += 180;
      } else if (part.type === "text" && part.text) {
        let fenced = false;
        let blank = false;
        for (const line of part.text.split("\n")) {
          if (/^\s*(```|~~~)/u.test(line)) {
            fenced = !fenced;
            size += 18;
          } else if (!line.trim()) {
            if (!blank) {
              size += 16;
            }
            blank = true;
            continue;
          } else {
            size += fenced
              ? 18
              : /^\s*(#{1,6} |\|)/u.test(line)
                ? 32
                : Math.max(1, Math.ceil(line.length / 85)) * 22;
          }
          blank = false;
        }
      }
    }
  }
  return Math.max(CHAT_TRANSCRIPT_ESTIMATED_ROW_PX, size);
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
    // Smaller transcripts scroll more cheaply without repeatedly mounting fragments.
    let sourceCount = 0;
    const windowCompletedFrames = chain.transcriptItems.some((item) => {
      for (const group of chatItemGroups(item)) {
        sourceCount += group.messages.length;
        if (sourceCount > 256) {
          return true;
        }
      }
      return false;
    });
    const loadedReplySources = new Map<string, LoadedReplySource>();
    const messageRowKeysById = new Map<string, string>();
    const transcriptMessageKeys = new Map<string, string>();
    const rows: TranscriptRow<ChatRenderItem>[] = [];
    const row = (item: ChatRenderItem, key = item.key): TranscriptRow<ChatRenderItem> => {
      if (item.kind === "agent-run-frame" && (item.fragment?.first || item.fragment?.last)) {
        // Edge chrome depends on the whole frame; fragment content alone cannot key its footprint.
        return { kind: "item", key, item };
      }
      const groups = chatItemGroups(item);
      const parts = item.kind === "agent-run-frame" ? item.parts : [item];
      const streaming =
        (item.kind === "agent-run-frame" && item.outcome.kind === "active") ||
        groups.some((group) => group.isStreaming) ||
        parts.some(
          (part) =>
            part.kind === "stream-run" ||
            part.kind === "stream" ||
            part.kind === "reading-indicator",
        );
      if (chain.continuations.has(item.key) || streaming) {
        return { kind: "item", key, item, streaming };
      }
      // Settled items keep their identity across unrelated live-tail changes.
      // Reactions replace their map; active and continuation rows never enter this memo.
      const revision = rowRevisions(item, [key, props.messageReactions], () => {
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
        return `${content.length}:${fnv1aUtf16(content)}`;
      });
      return { kind: "item", key, item, revision };
    };
    for (const item of chain.transcriptItems) {
      const rendered =
        windowCompletedFrames && item.kind === "agent-run-frame"
          ? completedFrameRows(item, expandedToolCards)
          : [item];
      for (const rowItem of rendered) {
        // Rich work sources include their Markdown and paired tool output.
        // Only split runs need advance materialization. Ordinary rows already
        // fit the virtual window; retaining them duplicates mixed-session DOM.
        const retainDom = rowItem.kind === "agent-run-frame" && Boolean(rowItem.fragment);
        const estimatedSize =
          rowItem.kind === "agent-run-frame" && rowItem.fragment
            ? rowItem.parts.reduce(
                (size, part) =>
                  size +
                  (part.kind === "group" && part.role === "assistant" ? part.messages.length : 1),
                0,
              ) *
              CHAT_TRANSCRIPT_ESTIMATED_ROW_PX *
              2
            : rowItem.kind === "group"
              ? estimateMessageGroupSize(rowItem)
              : undefined;
        rows.push({ ...row(rowItem), estimatedSize, retainDom });
      }
      if (item.kind === "work-group" && expandedToolCards.get(item.key)) {
        for (const group of item.groups) {
          rows.push(row(group, `${item.key}:${group.key}`));
        }
      }
      const parts = item.kind === "agent-run-frame" ? item.parts : [item];
      const groups = chatItemGroups(item);
      const firstGroup = groups.find((group) => group.role === "assistant") ?? groups[0];
      const fragmentKeys = new Map<string, string>();
      if (rendered.length > 1) {
        for (const rowItem of rendered) {
          for (const group of chatItemGroups(rowItem)) {
            for (const source of group.messages) {
              fragmentKeys.set(source.key, rowItem.key);
            }
          }
        }
      }
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
            const sourceRowKey = fragmentKeys.get(source.key) ?? rowKey;
            transcriptMessageKeys.set(source.key, sourceRowKey);
            const sourceMessageId = persistedMessageEntryId(source.message);
            if (sourceMessageId) {
              messageRowKeysById.set(sourceMessageId, sourceRowKey);
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

function completedFrameRows(
  frame: AgentRunFrameRenderItem,
  expanded: ReadonlyMap<string, boolean>,
): AgentRunFrameRenderItem[] {
  // Without an answer, the summary keeps the original row through disclosure changes.
  if (frame.outcome.kind !== "completed" || !frame.outcome.actionOwner) {
    return [frame];
  }
  // Late tool output can follow the final answer; retain that answer's row identity.
  const finalPart = frame.parts.at(-1);
  const actionOwner = frame.outcome.actionOwner;
  if (
    !finalPart ||
    !chatItemGroups(finalPart).some((group) => group.messages.includes(actionOwner))
  ) {
    return [frame];
  }
  const groups = chatItemGroups(frame);
  if (groups.reduce((count, group) => count + group.messages.length, 0) <= 32) {
    return [frame];
  }
  // Retained widgets move inside FrameBody at completion. Keep that one DOM owner
  // until cross-row widget handoff has its own lifecycle contract.
  if (
    groups.some((group) =>
      group.messages.some(
        ({ message }) =>
          normalizeMessage(message).content.some((part) => part.type === "canvas") ||
          extractToolCardsCached(message).some((card) => card.preview?.kind === "canvas"),
      ),
    )
  ) {
    return [frame];
  }
  const chunks: AgentRunFrameRenderItem["parts"][] = [];
  let pending: AgentRunFrameRenderItem["parts"] = [];
  let count = 0;
  const finishChunk = () => {
    if (pending.length) {
      chunks.push(pending);
      pending = [];
      count = 0;
    }
  };
  const append = (part: AgentRunFrameRenderItem["parts"][number]): void => {
    // Paired tool results can leave an entire run in one assistant group.
    if (
      part.kind === "group" &&
      part.role === "assistant" &&
      part.messages.length > COMPLETED_FRAME_ROW_MESSAGE_LIMIT
    ) {
      for (
        let offset = 0;
        offset < part.messages.length;
        offset += COMPLETED_FRAME_ROW_MESSAGE_LIMIT
      ) {
        const messages = part.messages.slice(offset, offset + COMPLETED_FRAME_ROW_MESSAGE_LIMIT);
        append(
          Object.assign({}, part, {
            key: offset === 0 ? part.key : `group:${part.role}:${messages[0]!.key}`,
            messages,
          }),
        );
      }
      return;
    }
    const weight = chatItemGroups(part).reduce((total, group) => total + group.messages.length, 0);
    if (count + weight > COMPLETED_FRAME_ROW_MESSAGE_LIMIT) {
      finishChunk();
    }
    pending.push(part);
    count += weight;
  };
  for (const [index, part] of frame.parts.entries()) {
    // The final answer retains the original frame key across completion and disclosure.
    if (index === frame.parts.length - 1) {
      finishChunk();
    }
    if (part.kind === "work-group") {
      finishChunk();
      chunks.push([part]);
      if (expanded.get(part.key)) {
        for (const group of part.groups) {
          append(group);
        }
        finishChunk();
      }
    } else {
      // A single activity disclosure remains atomic; never duplicate its summary/ARIA identity.
      append(part);
    }
  }
  finishChunk();
  if (chunks.length < 2) {
    return [frame];
  }
  const firstAssistant = groups.find((group) => group.role === "assistant");
  const work = frame.parts.find(
    (part) => part.kind === "work-group" && part.replyRunId === frame.runId,
  );
  const firstBubbleKey =
    frame.parts.flatMap((part) =>
      part.kind === "group" && part.role !== "tool"
        ? part.messages.filter((message) => message.hasVisibleContent).map((message) => message.key)
        : [],
    )[0] ?? null;
  return chunks.map((parts, index) =>
    Object.assign({}, frame, {
      key:
        index === chunks.length - 1
          ? frame.key
          : `${frame.key}:part:${parts[0]!.kind}:${parts[0]!.key}`,
      parts,
      fragment: {
        source: frame,
        first: index === 0,
        last: index === chunks.length - 1,
        firstAssistant,
        representative: firstAssistant ?? groups[0],
        firstBubbleKey,
        work: work?.kind === "work-group" ? work : undefined,
      },
    }),
  );
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
