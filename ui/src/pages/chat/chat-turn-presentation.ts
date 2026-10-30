import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { userTurnRunId } from "../../lib/chat/history-message-identity.ts";
import { extractToolCardsCached, isToolCardError } from "../../lib/chat/tool-cards.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  assistantMessageIsInterrupted,
  assistantMessageCanCompleteTurn,
  assistantMessageKind,
  groupEndsRunInFailure,
  isProviderVoiceTranscript,
  resolveAssistantReplyPhase,
} from "./chat-assistant-reply.ts";
import {
  assistantGroupIsIndependentBoundary,
  chatItemStartsUserTurn,
  hasForwardedSource,
} from "./chat-turn-boundary.ts";
import { chunkContiguousWork, splitMixedWorkGroup } from "./chat-work-chunks.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";

type RenderChatItem = ChatItem | MessageGroup;
export type StreamRunRenderItem = {
  kind: "stream-run";
  key: string;
  runId?: string;
  boundaryId?: string;
  replyToSender?: MessageGroup["replyToSender"];
  replyToMessage?: MessageGroup["replyToMessage"];
  parts: Array<Extract<ChatItem, { kind: "stream" | "reading-indicator" }>>;
};
export function coalesceStreamRuns(
  items: RenderChatItem[],
): Array<RenderChatItem | StreamRunRenderItem> {
  const result: Array<RenderChatItem | StreamRunRenderItem> = [];
  let run: StreamRunRenderItem["parts"] = [];
  const flush = () => {
    const [first] = run;
    if (first) {
      const { runId, boundaryId } = first;
      result.push({
        kind: "stream-run",
        key: `stream-run:${first.key}`,
        parts: run,
        replyToSender: run.find((part) => part.kind === "stream")?.replyToSender,
        replyToMessage: run.find((part) => part.kind === "stream")?.replyToMessage,
        ...(runId ? { runId } : {}),
        ...(boundaryId ? { boundaryId } : {}),
      });
      run = [];
    }
  };
  for (const item of items) {
    if (item.kind === "stream" || item.kind === "reading-indicator") {
      const first = run[0];
      if (first && (first.runId !== item.runId || first.boundaryId !== item.boundaryId)) {
        flush();
      }
      run.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}

/** Collapsed contiguous stretch of completed tools and reasoning. */
export type WorkGroupRenderItem = {
  kind: "work-group";
  key: string;
  groups: MessageGroup[];
  /** Terminal reply owning this rollup’s presentation, not its nested execution identities. */
  replyRunId?: string;
  /** Hidden group -> preceding preserved output; absent entries stay under the summary. */
  previewAfterGroup?: ReadonlyMap<string, string>;
  durationMs: number | null;
};

export type ActivityRunRenderItem = {
  kind: "activity-run";
  key: string;
  groups: MessageGroup[];
};

type TurnRenderItem = RenderChatItem | StreamRunRenderItem;

// User input, forwarded messages and structural markers bound presentation reordering.
function isTurnOutputGroup(item: TurnRenderItem): item is MessageGroup {
  return (
    item.kind === "group" &&
    (item.role === "assistant" || item.role === "tool") &&
    !assistantGroupIsIndependentBoundary(item) &&
    !hasForwardedSource(item)
  );
}

function isCollapsibleWorkGroup(item: TurnRenderItem): item is MessageGroup {
  if (
    item.kind !== "group" ||
    item.isStreaming ||
    groupHasVisibleReplyContent(item, item.role.toLowerCase() !== "tool") ||
    // Markdown-context fallbacks retain the tool role and the whole assistant
    // envelope. Its narration still bounds completed work.
    (item.visibleContent === "text" &&
      item.messages.some(
        ({ message, hasVisibleContent }) =>
          asRecord(message)?.role === "assistant" && hasVisibleContent,
      )) ||
    item.messages.some(({ message }) => isProviderVoiceTranscript(message))
  ) {
    return false;
  }
  const role = item.role.toLowerCase();
  return role === "tool" || (role === "assistant" && !assistantGroupIsIndependentBoundary(item));
}

function groupHasFailedResult(group: MessageGroup): boolean {
  return group.messages.some(({ message }) =>
    extractToolCardsCached(message).some(isToolCardError),
  );
}

function groupHasVisibleReplyContent(group: MessageGroup, includeText: boolean): boolean {
  return group.visibleContent === "non-text" || (includeText && group.visibleContent === "text");
}

// Unphased providers keep the last-visible-reply policy. Explicit commentary
// cannot move the completed-work boundary past an already delivered answer.
function isFinalReplyGroup(item: TurnRenderItem): item is MessageGroup {
  return (
    item.kind === "group" &&
    !item.isStreaming &&
    !groupEndsRunInFailure(item) &&
    assistantGroupCanOwnActiveRunStatus(item) &&
    item.messages.some(({ actionMessage, message }) =>
      assistantMessageCanCompleteTurn(actionMessage ?? message),
    ) &&
    assistantMessageKind(item.messages[0]?.message, item.visibleContent) !== "commentary"
  );
}

function turnUserMessages(turn: TurnRenderItem[]): unknown[] {
  const boundary = turn[0];
  if (!boundary || boundary.kind === "stream-run") {
    return [];
  }
  if (boundary.kind === "group") {
    return boundary.role.toLowerCase() === "user"
      ? boundary.messages.map(({ message }) => message)
      : [];
  }
  return boundary.kind === "message" && chatItemStartsUserTurn(boundary) ? [boundary.message] : [];
}

/**
 * Once a turn is done, fold only contiguous activity at its original position.
 * Visible text/media and structural markers bound every chunk. Live turns stay
 * expanded; history and source action identities are not changed.
 */
export function collapseCompletedTurnWork(
  items: TurnRenderItem[],
  opts: {
    sessionKey: string;
    runWorking: boolean;
    bubbleMode?: boolean;
    searchActive?: boolean;
  },
): Array<TurnRenderItem | WorkGroupRenderItem> {
  const [scope, agentId, kind, sessionId, ...extraParts] = normalizeLowercaseStringOrEmpty(
    opts.sessionKey,
  ).split(":");
  const isDashboardSession =
    scope === "agent" &&
    Boolean(agentId) &&
    kind === "dashboard" &&
    Boolean(sessionId) &&
    extraParts.length === 0;
  // Channel sessions can also be opened in the Control UI, but their full
  // transcript remains the canonical presentation on message surfaces.
  if (!isDashboardSession || opts.searchActive) {
    return items;
  }
  const turns: TurnRenderItem[][] = [];
  let currentTurn: TurnRenderItem[] = [];
  const projected = items.flatMap<TurnRenderItem>((item) =>
    item.kind === "group" ? splitMixedWorkGroup(item) : [item],
  );
  for (const item of projected) {
    if (item.kind !== "stream-run" && chatItemStartsUserTurn(item) && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(item);
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  const steerTarget = opts.runWorking
    ? turnUserMessages(turns.at(-1) ?? [])
        .map(persistedSteerTargetRunId)
        .findLast((runId) => runId !== null)
    : undefined;
  const targetTurnIndex = steerTarget
    ? turns.findIndex((turn) =>
        turnUserMessages(turn).some((message) => userTurnRunId(message) === steerTarget),
      )
    : -1;
  const liveTurnIndex = opts.runWorking
    ? targetTurnIndex >= 0
      ? targetTurnIndex
      : turns.length - 1
    : -1;

  const result: Array<TurnRenderItem | WorkGroupRenderItem> = [];
  for (const [turnIndex, turn] of turns.entries()) {
    // A trailing steer names the still-working turn above it; it does not own that work.
    const isLive =
      turnIndex === liveTurnIndex ||
      turn.some(
        (item) => item.kind === "stream-run" || (item.kind === "group" && item.isStreaming),
      );
    if (isLive) {
      result.push(...turn);
      continue;
    }
    const terminalReply = turn.findLast(isFinalReplyGroup);
    // Without a final reply, the tool rows are the turn's only visible result.
    // Keep them exposed instead of replacing the result with an opaque rollup.
    if (!terminalReply) {
      result.push(...turn);
      continue;
    }
    // Structural and forwarded boundaries cannot lend an answer to work in
    // another output segment, even though both belong to one user turn.
    const segmentReplies = new Map<string, { reply: MessageGroup; index: number }>();
    let segmentStart = 0;
    const closeSegment = (end: number) => {
      const reply = turn.slice(segmentStart, end).findLast(isFinalReplyGroup);
      if (reply) {
        const owner = { reply, index: turn.lastIndexOf(reply) };
        for (let index = segmentStart; index < end; index += 1) {
          segmentReplies.set(turn[index]!.key, owner);
        }
      }
    };
    let previousReplyIndex: number | undefined;
    for (let index = 0; index < turn.length; index += 1) {
      const item = turn[index]!;
      if (!isTurnOutputGroup(item)) {
        closeSegment(index);
        segmentStart = index + 1;
        previousReplyIndex = undefined;
      } else if (isFinalReplyGroup(item)) {
        if (previousReplyIndex !== undefined) {
          const previousReply = turn[previousReplyIndex];
          if (previousReply?.kind === "group" && previousReply.runId !== item.runId) {
            closeSegment(previousReplyIndex + 1);
            segmentStart = previousReplyIndex + 1;
          }
        }
        previousReplyIndex = index;
      }
    }
    closeSegment(turn.length);
    const replyRunIds = new Set<string>();
    for (const item of turn) {
      if (item.kind === "stream-run") {
        if (item.runId) {
          replyRunIds.add(item.runId);
        }
        continue;
      }
      if (item.kind !== "group" || item.runId === undefined) {
        continue;
      }
      // Tool-group text is the tool's own output shown inside the card, never a
      // reply; assistant/user text is the run's visible response.
      const includeText = item.role.toLowerCase() !== "tool";
      if (item.isStreaming || groupHasVisibleReplyContent(item, includeText)) {
        replyRunIds.add(item.runId);
      }
    }
    // A handoff owns request-wide footer timing and keeps its activity exposed.
    // Do not move even post-answer work across the visible answer.
    const handoff = turn.some((item) => item.kind === "notice" && item.handoffBoundary);
    const parts = turn.map((item, index) => {
      const segmentReply = segmentReplies.get(item.key);
      const eligible =
        segmentReply !== undefined &&
        !handoff &&
        isTurnOutputGroup(item) &&
        isCollapsibleWorkGroup(item) &&
        !groupEndsRunInFailure(item) &&
        (index < segmentReply.index ||
          ((!item.runId || replyRunIds.has(item.runId)) && !groupHasFailedResult(item)));
      return {
        id: item.key,
        kind: eligible ? ("work" as const) : ("boundary" as const),
        value: item,
      };
    });
    const chunks = chunkContiguousWork(parts);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (chunk.kind === "visible") {
        result.push(...chunk.parts.map((part) => part.value));
        continue;
      }
      // SAFETY: only isTurnOutputGroup-narrowed MessageGroups are classified as work above.
      const groups = chunk.parts.map((part) => part.value as MessageGroup);
      // The segment's reply owns presentation even when continuations or
      // untagged tools have different execution identities. Segment boundaries
      // already exclude forwarded deliveries and independent replies.
      const replyRunId = segmentReplies.get(groups[0]!.key)?.reply.runId;
      result.push({
        kind: "work-group",
        // Older pages can prepend work; the following visible boundary survives.
        key: `work:${chunks[chunkIndex + 1]?.parts[0]?.id ?? groups.at(-1)!.key}`,
        groups,
        ...(replyRunId ? { replyRunId } : {}),
        // Lifecycle runtime measures the whole run, not this bounded stretch.
        // Without authoritative per-chunk timing, keep the disclosure untimed.
        durationMs: null,
      });
    }
  }
  return result;
}

export type CompletedTurnRenderItem = TurnRenderItem | WorkGroupRenderItem;

// Adjacent activity is one disclosure even when automatic continuations use
// new run IDs. Visible content, not other output elsewhere in those runs,
// bounds the log. Reuse prepared visibility and cached cards in this pass.
function isActivityGroup(group: MessageGroup): boolean {
  if (group.isStreaming || group.visibleContent === "non-text" || hasForwardedSource(group)) {
    return false;
  }
  // Tool-call content is normalized to the tool role. Its original assistant
  // envelope still owns narration and terminal outcomes; do not hide those.
  if (
    group.messages.some(({ message, hasVisibleContent }) => {
      const record = asRecord(message);
      return (
        record?.role === "assistant" &&
        (hasVisibleContent ||
          resolveAssistantReplyPhase(message) === "final_answer" ||
          assistantMessageIsInterrupted(message) ||
          record.stopReason === "error")
      );
    })
  ) {
    return false;
  }
  const role = group.role.toLowerCase();
  return (
    role === "tool" ||
    (role === "assistant" &&
      group.visibleContent === "none" &&
      group.messages.some(({ message }) => extractToolCardsCached(message).length > 0))
  );
}

function activityRun(groups: MessageGroup[]): ActivityRunRenderItem {
  return { kind: "activity-run", key: `activity:${groups[0]!.key}`, groups };
}

/**
 * One log for two operation rows that nothing visible separates, keeping the
 * first row's identity. Undefined when either side is not an operation row.
 */
export function joinActivityRuns(
  first: CompletedTurnRenderItem | ActivityRunRenderItem,
  next: CompletedTurnRenderItem | ActivityRunRenderItem,
): ActivityRunRenderItem | undefined {
  const groupsOf = (item: CompletedTurnRenderItem | ActivityRunRenderItem) =>
    item.kind === "activity-run"
      ? item.groups
      : item.kind === "group" && isActivityGroup(item)
        ? [item]
        : undefined;
  const before = groupsOf(first);
  const after = groupsOf(next);
  return before && after ? activityRun([...before, ...after]) : undefined;
}

/** Presentation-only rollup for tool groups separated by projected turn boundaries. */
export function coalesceActivityRuns(
  items: CompletedTurnRenderItem[],
  opts: { searchActive?: boolean } = {},
): Array<CompletedTurnRenderItem | ActivityRunRenderItem> {
  if (opts.searchActive) {
    return items;
  }
  const result: Array<CompletedTurnRenderItem | ActivityRunRenderItem> = [];
  let groups: MessageGroup[] = [];
  const flush = () => {
    const [first] = groups;
    if (!first) {
      return;
    }
    result.push(groups.length === 1 ? first : activityRun(groups));
    groups = [];
  };
  for (const item of items) {
    if (item.kind === "group" && isActivityGroup(item)) {
      groups.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();
  return result;
}
