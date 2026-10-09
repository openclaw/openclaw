import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { messageClientSourcesKey } from "../../../../src/chat/message-client-source.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import {
  senderIdentityKey,
  sessionParticipantIdentityKey,
  type SenderIdentity,
} from "../../lib/chat/sender-label.ts";
import { extractToolCardsCached, isToolCardError } from "../../lib/chat/tool-cards.ts";
import {
  assistantMessageIsInterrupted,
  resolveAssistantReplyPhase,
} from "./chat-assistant-reply.ts";
import { prepareMessagesForGrouping } from "./chat-thread-duplicates.ts";
import { userTurnRunId } from "./chat-thread-items.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import {
  assistantGroupIsForwardedBoundary,
  chatItemStartsDisplayTurn,
  chatItemStartsUserTurn,
  hasForwardedSource,
  isInterSessionMessage,
  readAutomationRun,
} from "./chat-turn-boundary.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";

function assistantMessageKind(message: unknown, visibleContent: MessageGroup["visibleContent"]) {
  return resolveAssistantReplyPhase(message) ?? (visibleContent === "none" ? "activity" : "reply");
}

/**
 * Keys a sender without a typed identity by its id alone; names change, ids do
 * not. The Gateway stores a profile user's id as `senderId` (typed identities
 * persist only when their id equals it), so an untyped id that matches a
 * counted profile is that person. Any other untyped id is its own person.
 */
function untypedSenderPersonKey(
  sender: SenderIdentity,
  people: ReadonlySet<string>,
  localPerson: string | undefined,
): string {
  if (!sender.id) {
    return JSON.stringify(["sender-label", sender.username ?? sender.name ?? ""]);
  }
  const profile = sessionParticipantIdentityKey({ type: "profile", id: sender.id });
  return people.has(profile) || profile === localPerson
    ? profile
    : JSON.stringify(["sender", sender.id]);
}

type ReplyState = {
  sender?: MessageGroup["sender"];
  message?: MessageGroup["replyToMessage"];
  turnSource?: MessageGroup["replyTurnSource"];
};

/**
 * Reply context comes from the full transcript, not the rendered rows: search
 * renders a subset that can drop the other speaker or the prompt a reply answers.
 */
function stampReplyAttribution(
  items: Array<ChatItem | MessageGroup>,
  context: Array<ChatItem | MessageGroup>,
  { people: sessionPeople, localPerson }: ReplyAttributionContext,
): Array<ChatItem | MessageGroup> {
  const people = new Set(sessionPeople);
  const untypedSenders: SenderIdentity[] = [];
  // reply_to_current names the prompt that started the run. Only the persisted
  // user-turn run identity resolves it; an ambiguous owner stays unresolved.
  const runPrompts = new Map<string, MessageGroup["messages"][number] | null>();
  const stateBefore = new Map<string, ReplyState>();
  let state: ReplyState = {};
  for (const item of context) {
    // System notices and projected/forwarded inputs own turns too. Clear the
    // previous prompt before recording reply state for their output.
    if (chatItemStartsUserTurn(item) && !(item.kind === "group" && item.role === "user")) {
      state = {};
    }
    if (item.kind === "stream") {
      stateBefore.set(item.key, state);
    }
    if (item.kind !== "group") {
      continue;
    }
    for (const source of item.messages) {
      stateBefore.set(source.key, state);
    }
    if (item.role === "user") {
      for (const source of item.messages) {
        const runId = userTurnRunId(source.message);
        if (runId) {
          runPrompts.set(runId, runPrompts.has(runId) ? null : source);
        }
      }
      // A local message carries no sender metadata: its author is the signed-in
      // viewer, one person for counting, never a name for this message.
      if (item.sender?.identity) {
        people.add(sessionParticipantIdentityKey(item.sender.identity));
      } else if (item.sender) {
        untypedSenders.push(item.sender);
      } else if (!item.senderSession && localPerson) {
        people.add(localPerson);
      }
      // A sender-less user group clears attribution: no chip is safer than
      // mislabeling the reply as addressed to the previous participant.
      const last = item.messages.at(-1);
      state = { sender: item.sender, message: item.sender ? last : undefined, turnSource: last };
    } else if (item.role === "assistant" && hasForwardedSource(item)) {
      // Forwarded input starts a turn without a local human reply recipient.
      state = {};
    }
  }
  // Untyped senders resolve after every typed person is known, so order never splits one.
  for (const sender of untypedSenders) {
    people.add(untypedSenderPersonKey(sender, people, localPerson));
  }
  // Automatic attribution is only useful when several people share the thread.
  const shared = people.size >= 2;

  // Rows outside the context (live output) take the state of the next row that
  // has one, or the transcript end.
  const states: ReplyState[] = [];
  let next = state;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const known =
      item.kind === "group"
        ? item.messages.map((source) => stateBefore.get(source.key)).find(Boolean)
        : item.kind === "stream"
          ? stateBefore.get(item.key)
          : undefined;
    next = known ?? next;
    states[index] = next;
  }
  for (const [index, item] of items.entries()) {
    const { sender, message, turnSource } = states[index]!;
    if (item.kind === "stream") {
      if (shared) {
        item.replyToSender = sender;
        item.replyToMessage = message;
      }
      continue;
    }
    if (item.kind !== "group") {
      continue;
    }
    // Every strip follows the thread: an unattributed source is "You" only in 1:1.
    if (shared) {
      item.replyShared = true;
    }
    if (item.role !== "assistant" || hasForwardedSource(item)) {
      continue;
    }
    const currentSource =
      item.runId && item.messages.some((source) => source.replyTarget?.kind === "current")
        ? runPrompts.get(item.runId)
        : undefined;
    if (turnSource) {
      item.replyTurnSource = turnSource;
    }
    if (currentSource) {
      item.replyCurrentSource = currentSource;
    }
    if (shared && sender) {
      item.replyToSender = sender;
      item.replyToMessage = message;
    }
  }
  return items;
}

/** Transcript facts that outlive the rendered subset of rows. */
export type ReplyAttributionContext = {
  /** Every transcript row, including those a search hides from `items`. */
  items?: ChatItem[];
  /** People the session row lists, keyed by `sessionParticipantIdentityKey`. */
  people?: readonly string[];
  /** Key of the signed-in viewer, who authors local user messages without a sender. */
  localPerson?: string;
};

export function groupMessages(
  items: ChatItem[],
  replyContext: ReplyAttributionContext = {},
): Array<ChatItem | MessageGroup> {
  const result = groupChatItems(
    items,
    replyContext.items && rowsAfterHiddenTurns(items, replyContext.items),
  );
  const context = replyContext.items ? groupChatItems(replyContext.items) : result;
  return stampReplyAttribution(result, context, replyContext);
}

/** Search hides rows, not turns: a row after a hidden turn start never joins the group before it. */
function rowsAfterHiddenTurns(items: ChatItem[], context: ChatItem[]): Set<string> {
  const visible = new Set(items.map((item) => item.key));
  const rows = new Set<string>();
  let hiddenTurn = false;
  for (const item of context) {
    if (!visible.has(item.key)) {
      hiddenTurn ||= chatItemStartsDisplayTurn(item);
    } else if (hiddenTurn) {
      rows.add(item.key);
      hiddenTurn = false;
    }
  }
  return rows;
}

function groupChatItems(
  items: ChatItem[],
  rowsAfterHiddenTurn?: ReadonlySet<string>,
): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;
  let currentUserTurnIdentity: string | null = null;
  let currentReplyTargetKey: string | null = null;

  for (const prepared of prepareMessagesForGrouping(items)) {
    if (prepared.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(prepared);
      continue;
    }

    const { item, normalized } = prepared;
    const role = normalizeRoleForGrouping(normalized.role);
    // Classify after content projection and keep the fact with its group; later
    // presentation passes reuse it; replacing a message refreshes its facts.
    const visibleContent = resolveMessageVisibleContent(item.message, normalized);
    const source = {
      message: item.message,
      key: item.key,
      duplicateCount: item.duplicateCount,
      ...(normalized.replyTarget ? { replyTarget: normalized.replyTarget } : {}),
      hasVisibleContent:
        visibleContent === "non-text" ||
        Boolean(resolveMessageDisplayMarkdown(item.message, normalized).trim()),
    };
    const senderLabel =
      role === "user" || role === "assistant" ? (normalized.senderLabel ?? null) : null;
    const sender = role === "user" ? normalized.sender : undefined;
    const timestamp = normalized.timestamp || Date.now();
    const runId =
      role === "assistant" || role === "tool" ? transcriptRunId(item.message) : undefined;
    // Independent sends own separate elapsed boundaries; consecutive steers
    // before any output keep their target run's original start. Do not stamp
    // user runIds onto groups: reply-less activity pooling uses that field.
    const steerTarget = role === "user" ? persistedSteerTargetRunId(item.message) : null;
    const userTurnIdentity = role === "user" ? (steerTarget ?? userTurnRunId(item.message)) : null;
    const replyTargetKey =
      role === "assistant" ? JSON.stringify(normalized.replyTarget ?? null) : null;
    const shouldSplitBySender = role === "user" || role === "assistant";
    const startsProjectedTurn =
      item.startsTurn === true ||
      rowsAfterHiddenTurn?.has(item.key) === true ||
      asRecord(asRecord(item.message)?.["__openclaw"])?.turnBoundary === true;
    const splitsAssistantKind =
      role === "assistant" &&
      currentGroup?.role === "assistant" &&
      assistantMessageKind(currentGroup.messages[0]?.message, currentGroup.visibleContent) !==
        assistantMessageKind(item.message, visibleContent);

    if (
      !currentGroup ||
      startsProjectedTurn ||
      // Each automation input owns a turn, including old rows without a projected marker.
      Boolean(
        readAutomationRun(item.message) || readAutomationRun(currentGroup.messages[0]?.message),
      ) ||
      (isInterSessionMessage(item.message) && !normalized.senderSession?.sessionKey) ||
      currentGroup.role !== role ||
      currentGroup.runId !== runId ||
      isInterSessionMessage(currentGroup.messages[0]?.message) !==
        isInterSessionMessage(item.message) ||
      currentUserTurnIdentity !== userTurnIdentity ||
      (role === "assistant" && currentReplyTargetKey !== replyTargetKey) ||
      splitsAssistantKind ||
      messageClientSourcesKey(currentGroup.sourceClients ?? []) !==
        messageClientSourcesKey(normalized.sourceClients ?? []) ||
      (shouldSplitBySender &&
        ((!sender?.identity && currentGroup.senderLabel !== senderLabel) ||
          currentGroup.senderSession?.sessionKey !== normalized.senderSession?.sessionKey ||
          currentGroup.senderSession?.label !== normalized.senderSession?.label ||
          currentGroup.senderSession?.agentId !== normalized.senderSession?.agentId ||
          senderIdentityKey(currentGroup.sender) !== senderIdentityKey(sender)))
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentUserTurnIdentity = userTurnIdentity;
      currentReplyTargetKey = replyTargetKey;
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        ...(normalized.senderSession ? { senderSession: normalized.senderSession } : {}),
        ...(sender ? { sender } : {}),
        ...(normalized.sourceClients ? { sourceClients: normalized.sourceClients } : {}),
        messages: [source],
        visibleContent,
        timestamp,
        isStreaming: false,
        ...(runId ? { runId } : {}),
      };
    } else {
      if (visibleContent === "non-text" || currentGroup.visibleContent === "none") {
        currentGroup.visibleContent = visibleContent;
      }
      currentGroup.messages.push(source);
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

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

/** Collapsed rollup of a completed turn's activity (tools, commentary, reasoning). */
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
    !assistantGroupIsForwardedBoundary(item)
  );
}

function isCollapsibleWorkGroup(item: TurnRenderItem): item is MessageGroup {
  if (item.kind !== "group" || item.isStreaming || groupHasVisibleReplyContent(item, false)) {
    return false;
  }
  const role = item.role.toLowerCase();
  return (
    role === "tool" ||
    (role === "assistant" &&
      !assistantGroupIsForwardedBoundary(item) &&
      assistantMessageKind(item.messages[0]?.message, item.visibleContent) !== "final_answer")
  );
}

function groupHasFailedResult(group: MessageGroup): boolean {
  return group.messages.some(({ message }) =>
    extractToolCardsCached(message).some(isToolCardError),
  );
}

/** A group holding the message that ended its run in failure; it marks where the run stopped. */
export function groupEndsRunInFailure(group: MessageGroup): boolean {
  return group.messages.some(
    ({ message }) =>
      assistantMessageIsInterrupted(message) || asRecord(message)?.stopReason === "error",
  );
}

function groupHasVisibleReplyContent(group: MessageGroup, includeText = true): boolean {
  return group.visibleContent === "non-text" || (includeText && group.visibleContent === "text");
}

export function assistantGroupCanOwnActiveRunStatus(group: MessageGroup): boolean {
  return (
    group.role.toLowerCase() === "assistant" &&
    !assistantGroupIsForwardedBoundary(group) &&
    groupHasVisibleReplyContent(group)
  );
}

// Unphased providers keep the last-visible-reply policy. Explicit commentary
// cannot move the completed-work boundary past an already delivered answer.
function isFinalReplyGroup(item: TurnRenderItem): item is MessageGroup {
  return (
    item.kind === "group" &&
    !item.isStreaming &&
    assistantGroupCanOwnActiveRunStatus(item) &&
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
 * Once a turn is done, collect its activity above the preserved answers in one
 * "Worked for X" disclosure. Each partition retains source order without changing
 * the stored transcript. Live turns stay expanded; structural markers stay anchored.
 */
export function collapseCompletedTurnWork(
  items: TurnRenderItem[],
  opts: {
    sessionKey: string;
    runWorking: boolean;
    searchActive?: boolean;
    session?: Pick<GatewaySessionRow, "key" | "lastRunId" | "status" | "runtimeMs">;
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
  for (const item of items) {
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
    const finalReplyIndex = turn.lastIndexOf(terminalReply);
    // Partition the answer's output segment, including work after the last answer.
    // Never move activity across a user, forwarded input, or structural marker.
    let segmentStart = finalReplyIndex;
    let segmentEnd = segmentStart;
    while (segmentStart > 0 && isTurnOutputGroup(turn[segmentStart - 1]!)) {
      segmentStart -= 1;
    }
    // A turn that handed off keeps its work in place: while it waits, between
    // the wait ending and the resume, and once the resumed run has answered in
    // the same block. Its closing line reports the whole request instead of a
    // rollup timed for the last run.
    if (turn.some((item) => item.kind === "notice" && item.handoffBoundary)) {
      // Work the answering run recorded after its answer, such as the step
      // that sent it, still goes above that answer, where a rollup puts it, so
      // the answer stays last. Nothing moves past a handoff, which keeps a
      // handoff's own sentence above its work, and nothing moves when any of
      // it failed or ended the run: that stays where it happened.
      const answer = finalReplyIndex >= 0 ? terminalReply : undefined;
      const trailing = turn.slice(finalReplyIndex + 1);
      const answerLast =
        answer?.runId !== undefined &&
        trailing.length > 0 &&
        trailing.every(
          (item) =>
            isCollapsibleWorkGroup(item) &&
            item.runId === answer.runId &&
            !groupHasFailedResult(item) &&
            !groupEndsRunInFailure(item),
        );
      result.push(
        ...(answerLast ? [...turn.slice(0, finalReplyIndex), ...trailing, answer] : turn),
      );
      continue;
    }
    // Independent reply-less runs retain their own activity rollup, rather than
    // becoming work for an earlier answer merely because no user spoke between them.
    const replyRunIds = runIdsWithVisibleReplies(turn);
    while (segmentEnd + 1 < turn.length) {
      const next = turn[segmentEnd + 1]!;
      if (!isTurnOutputGroup(next) || (next.runId && !replyRunIds.has(next.runId))) {
        break;
      }
      segmentEnd += 1;
    }
    const groups: MessageGroup[] = [];
    const answers: TurnRenderItem[] = [];
    const previewAfterGroup = new Map<string, string>();
    let precedingAnswerKey: string | undefined;
    for (let index = segmentStart; index <= segmentEnd; index += 1) {
      const item = turn[index]!;
      // Only a later answer can put a failed result inside completed work.
      // Share the renderer's error classification, including structured results.
      if (
        index !== finalReplyIndex &&
        isCollapsibleWorkGroup(item) &&
        (index < finalReplyIndex || !groupHasFailedResult(item))
      ) {
        groups.push(item);
        if (precedingAnswerKey) {
          previewAfterGroup.set(item.key, precedingAnswerKey);
        }
      } else {
        answers.push(item);
        precedingAnswerKey = item.key;
      }
    }
    if (groups.length === 0) {
      result.push(...turn);
      continue;
    }
    // Message timestamps describe creation, not completion of the final model
    // request. Only the lifecycle owner can supply elapsed time for this run.
    // Older history without matching lifecycle facts keeps an untimed disclosure.
    const session = opts.session;
    const runtimeMs = session?.runtimeMs;
    const durationMs =
      session?.key === opts.sessionKey &&
      terminalReply.runId !== undefined &&
      session.lastRunId === terminalReply.runId &&
      (session.status === "done" ||
        session.status === "failed" ||
        session.status === "timeout" ||
        session.status === "killed") &&
      typeof runtimeMs === "number" &&
      Number.isFinite(runtimeMs) &&
      runtimeMs >= 0
        ? runtimeMs
        : null;
    // A completed rollup may span automatic resumptions. Its reply owns the
    // display only when earlier answers belong to that same run.
    const replyRunId =
      !hasForwardedSource(terminalReply) &&
      !groups.some(hasForwardedSource) &&
      answers
        .slice(0, answers.indexOf(terminalReply))
        .every(
          (answer) =>
            answer.kind === "group" &&
            !hasForwardedSource(answer) &&
            answer.runId === terminalReply.runId,
        )
        ? terminalReply.runId
        : undefined;
    result.push(...turn.slice(0, segmentStart));
    result.push({
      kind: "work-group",
      // The final reply survives older-history prepends; the first work row does not.
      key: `work:${terminalReply.key}`,
      groups,
      ...(replyRunId ? { replyRunId } : {}),
      ...(previewAfterGroup.size > 0 ? { previewAfterGroup } : {}),
      durationMs,
    });
    result.push(...answers, ...turn.slice(segmentEnd + 1));
  }
  return result;
}

export type CompletedTurnRenderItem = TurnRenderItem | WorkGroupRenderItem;

// Completed work may include activity after an answer only when that activity
// belongs to a run with a visible reply, not an independent background wake.
function runIdsWithVisibleReplies(items: CompletedTurnRenderItem[]): Set<string> {
  const replyRunIds = new Set<string>();
  for (const item of items) {
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
  return replyRunIds;
}

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
