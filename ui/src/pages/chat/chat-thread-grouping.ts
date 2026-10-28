import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { messageClientSourcesKey } from "../../../../src/chat/message-client-source.js";
import type { ChatItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import {
  readChatThreadMessageIdentity,
  userTurnRunId,
} from "../../lib/chat/history-message-identity.ts";
import { resolveMessageDisplayMarkdown } from "../../lib/chat/message-display.ts";
import { extractThinkingCached } from "../../lib/chat/message-extract.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../lib/chat/message-visibility.ts";
import {
  senderIdentityKey,
  sessionParticipantIdentityKey,
  type SenderIdentity,
} from "../../lib/chat/sender-label.ts";
import { hasVisiblePreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { assistantMessageIsInterrupted, assistantMessageKind } from "./chat-assistant-reply.ts";
import { prepareMessagesForGrouping } from "./chat-thread-duplicates.ts";
import { transcriptRunId } from "./chat-thread-run-identity.ts";
import {
  assistantGroupIsIndependentBoundary,
  assistantMessageIsAutomationResult,
  chatItemStartsDisplayTurn,
  chatItemStartsUserTurn,
  hasForwardedSource,
  isInterSessionMessage,
  readAutomationRun,
} from "./chat-turn-boundary.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";
import type { ChatReasoning } from "./tool-stream-contract.ts";

type ReplyState = {
  sender?: MessageGroup["sender"];
  message?: MessageGroup["replyToMessage"];
  turnSource?: MessageGroup["replyTurnSource"];
};

/** Transcript facts that outlive the rendered subset of rows. */
export type ReplyAttributionContext = {
  /** Every transcript row, including those a search hides from `items`. */
  items?: ChatItem[];
  /** People the session row lists, keyed by `sessionParticipantIdentityKey`. */
  people?: readonly string[];
  /** Key of the signed-in viewer, who authors local user messages without a sender. */
  localPerson?: string;
};

const groupedSegments = new WeakMap<
  object,
  { inputs: unknown[]; items: Array<ChatItem | MessageGroup> }
>();

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
  visibleReasoning: ReadonlySet<string>,
  rowsAfterHiddenTurn?: ReadonlySet<string>,
  showReasoning = false,
): Array<ChatItem | MessageGroup> {
  const reasoningKey = JSON.stringify([...visibleReasoning]);
  const result: Array<ChatItem | MessageGroup> = [];
  let source: Array<Extract<ChatItem, { kind: "message" }>> = [];
  const flush = () => {
    if (source.length === 0) {
      return;
    }
    const owner = asRecord(source[0]?.message);
    const inputs: unknown[] = [reasoningKey, showReasoning];
    for (const item of source) {
      inputs.push(
        item.key,
        item.message,
        normalizeMessage(item.message),
        item.startsTurn,
        rowsAfterHiddenTurn?.has(item.key) === true,
      );
    }
    const cached = owner && groupedSegments.get(owner);
    const grouped =
      cached &&
      cached.inputs.length === inputs.length &&
      inputs.every((input, index) => input === cached.inputs[index])
        ? cached.items
        : groupChatItemSegment(source, visibleReasoning, rowsAfterHiddenTurn, showReasoning);
    if (grouped !== cached?.items) {
      const segment = { inputs, items: grouped };
      // Hidden or retained source objects must not keep overlapping old snapshots alive.
      for (const item of source) {
        const message = asRecord(item.message);
        if (message) {
          const previous = groupedSegments.get(message);
          if (previous && previous !== segment && previous.inputs.length > 0) {
            previous.inputs = [];
            previous.items = [];
          }
          groupedSegments.set(message, segment);
        }
      }
    }
    // Attribution is transcript-wide and must never annotate cached local groups.
    for (const item of grouped) {
      result.push(item.kind === "group" ? { ...item } : item);
    }
    source = [];
  };
  for (const [index, item] of items.entries()) {
    if (item.kind !== "message") {
      flush();
      result.push(item);
      continue;
    }
    const previous = items[index - 1];
    if (
      previous?.kind === "message" &&
      normalizeRoleForGrouping(normalizeMessage(item.message).role) === "user"
    ) {
      const normalized = normalizeMessage(previous.message);
      const role = normalizeRoleForGrouping(normalized.role);
      // A visible non-user row guarantees a grouping and duplicate boundary.
      // Keep hidden rows and consecutive inputs together for the canonical grouper.
      if (
        role !== "user" &&
        (role !== "assistant" ||
          resolveMessageVisibleContent(previous.message, normalized) === "non-text" ||
          resolveMessageDisplayMarkdown(previous.message, normalized).trim())
      ) {
        flush();
      }
    }
    source.push(item);
  }
  flush();
  return result;
}

export function groupMessages(
  items: ChatItem[],
  replyContext: ReplyAttributionContext = {},
  reasoning?: ChatReasoning | null,
  showReasoning = false,
): Array<ChatItem | MessageGroup> {
  const visibleReasoning = new Set(
    reasoning?.items.flatMap(({ receipt }) =>
      receipt?.persisted ? [JSON.stringify([receipt.runId, receipt.messageId])] : [],
    ),
  );
  const result = groupChatItems(
    items,
    visibleReasoning,
    replyContext.items && rowsAfterHiddenTurns(items, replyContext.items),
    showReasoning,
  );
  const context = replyContext.items
    ? groupChatItems(replyContext.items, visibleReasoning, undefined, showReasoning)
    : result;
  /**
   * Reply context comes from the full transcript, not the rendered rows: search
   * renders a subset that can drop the other speaker or the prompt a reply answers.
   */
  const { people: sessionPeople, localPerson } = replyContext;
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
    } else if (
      item.role === "assistant" &&
      (hasForwardedSource(item) || assistantGroupIsIndependentBoundary(item))
    ) {
      // Forwarded input starts a turn without a local human reply recipient.
      state = {};
    }
  }
  // Untyped senders resolve after every typed person is known, so order never splits one.
  /**
   * Keys a sender without a typed identity by its id alone; names change, ids do
   * not. The Gateway stores a profile user's id as `senderId` (typed identities
   * persist only when their id equals it), so an untyped id that matches a
   * counted profile is that person. Any other untyped id is its own person.
   */
  for (const sender of untypedSenders) {
    if (!sender.id) {
      people.add(JSON.stringify(["sender-label", sender.username ?? sender.name ?? ""]));
      continue;
    }
    const profile = sessionParticipantIdentityKey({ type: "profile", id: sender.id });
    people.add(
      people.has(profile) || profile === localPerson
        ? profile
        : JSON.stringify(["sender", sender.id]),
    );
  }
  // Automatic attribution is only useful when several people share the thread.
  const shared = people.size >= 2;

  // Rows outside the context (live output) take the state of the next row that
  // has one, or the transcript end.
  const states: ReplyState[] = [];
  let next = state;
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const item = result[index]!;
    const known =
      item.kind === "group"
        ? item.messages.map((source) => stateBefore.get(source.key)).find(Boolean)
        : item.kind === "stream"
          ? stateBefore.get(item.key)
          : undefined;
    next = known ?? next;
    states[index] = next;
  }
  for (const [index, item] of result.entries()) {
    const { sender, message, turnSource } = states[index]!;
    if (item.kind === "group") {
      // Every strip follows the thread: an unattributed source is "You" only in 1:1.
      if (shared) {
        item.replyShared = true;
      }
      if (
        item.role !== "assistant" ||
        hasForwardedSource(item) ||
        assistantGroupIsIndependentBoundary(item)
      ) {
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
    } else if (item.kind !== "stream") {
      continue;
    }
    if (shared && (item.kind === "stream" || sender)) {
      item.replyToSender = sender;
      item.replyToMessage = message;
    }
  }
  return result;
}

function groupChatItemSegment(
  items: ChatItem[],
  visibleReasoning: ReadonlySet<string>,
  rowsAfterHiddenTurn?: ReadonlySet<string>,
  showReasoning = false,
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
    const record = asRecord(item.message);
    const identity = visibleReasoning.size ? readChatThreadMessageIdentity(item.message) : null;
    const hasVisibleReasoning =
      identity?.role === "assistant" &&
      !identity.isImported &&
      visibleReasoning.has(JSON.stringify([identity.runId, identity.id])) &&
      Boolean(extractThinkingCached(item.message));
    const hasAssistantText =
      record?.role === "assistant" &&
      record.stopReason === "toolUse" &&
      Boolean(resolveMessageDisplayMarkdown(item.message, normalized).trim());
    // Saved reasoning stays visible until its live owner retires the receipts.
    // Legacy mixed rows retain their tool grouping and file-link attribution.
    // Classify after content projection; prepared outcomes may outlive their blocks.
    const visibleContent = resolveMessageVisibleContent(item.message, normalized);
    const normalizedRole = normalizeRoleForGrouping(normalized.role);
    const hasPreparedActivity =
      normalizedRole === "assistant" &&
      visibleContent === "none" &&
      hasVisiblePreparedActivity(item.message);
    const role =
      hasAssistantText || hasVisibleReasoning
        ? "assistant"
        : hasPreparedActivity
          ? "tool"
          : normalizedRole;
    const source = {
      message: item.message,
      key: item.key,
      ...(normalized.replyTarget ? { replyTarget: normalized.replyTarget } : {}),
      hasVisibleContent:
        hasVisibleReasoning ||
        (showReasoning && role === "assistant" && Boolean(extractThinkingCached(item.message))) ||
        visibleContent === "non-text" ||
        Boolean(resolveMessageDisplayMarkdown(item.message, normalized).trim()),
    };
    // Projection can remove the last tool block, leaving only hidden thinking.
    // Keep recorded interruptions/errors, which have their own visible outcome.
    if (
      role === "assistant" &&
      !source.hasVisibleContent &&
      !assistantMessageIsInterrupted(item.message) &&
      record?.stopReason !== "error"
    ) {
      continue;
    }
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
        readAutomationRun(item.message) ||
        readAutomationRun(currentGroup.messages[0]?.message) ||
        assistantMessageIsAutomationResult(item.message) ||
        assistantMessageIsAutomationResult(currentGroup.messages[0]?.message),
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
