import { messageClientSourcesKey } from "../../../../src/chat/message-client-source.js";
import {
  accumulatedStreamText,
  trimAccumulatedStreamPrefix,
  type ChatItem,
  type MessageGroup,
} from "../../lib/chat/chat-types.ts";
import { stripHeartbeatTokenForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { isStandaloneToolMessageForDisplay } from "../../lib/chat/message-normalizer.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  messageRecoveryKey,
  type AssistantMessageExpansionState,
} from "./chat-message-recovery.ts";
import { resetWorkingProgress } from "./chat-progress.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import type { ChatInputOrderState } from "./chat-thread-inputs.ts";
import { readChatThreadMessageIdentity, sanitizeStreamText } from "./chat-thread-items.ts";
import { getOrCreateSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";

export { persistedMessageEntryId, readPendingSendStatus } from "./chat-thread-items.ts";
export {
  assistantGroupCanOwnActiveRunStatus,
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
} from "./chat-thread-grouping.ts";
export { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";

type CachedChatItems = {
  generation: number;
  input: BuildChatItemsProps | null;
  items: ReturnType<typeof buildChatItems>;
  liveStream: {
    index: number;
    identity: string;
    prefix: string | null;
  } | null;
};

type RenderChatItem = ReturnType<typeof buildChatItems>[number];

type ToolCardExpansionState = {
  expanded: Map<string, boolean>;
  // Group disclosures share the map but must stay outside tool-only auto-expand and pruning.
  initialized: Set<string>;
  /** The tool call behind each disclosure of the last complete projection. */
  calls?: Map<string, string>;
  lastSync?: {
    // The scan memo must not retain messages after their owning pane releases them.
    items: WeakRef<readonly RenderChatItem[]>;
    isFilteredProjection: boolean;
    autoExpandToolCalls: boolean;
  };
};

type ChatItemsProjection = "visible" | "unfiltered";
type CachedChatProjections = Partial<Record<ChatItemsProjection, CachedChatItems>> & {
  inputOrder: ChatInputOrderState;
  initialTurnId: BuildChatItemsProps["initialTurnId"];
};
// Search and gallery inputs must not evict each other. Both projections share
// the pane/session's input order, bounded lifetime, and canonical builder.
const chatItemsByPane = new Map<string, Map<string, CachedChatProjections>>();
const chatItemsGenerations = new WeakMap<readonly RenderChatItem[], number>();
const toolCardStateBySession = new Map<string, ToolCardExpansionState>();
const expandedUserMessagesBySession = new Map<string, Map<string, boolean>>();
const expansionMapVersions = new WeakMap<ReadonlyMap<string, unknown>, number>();

export function resetChatThreadState(paneId?: string): void {
  if (paneId) {
    chatItemsByPane.delete(paneId);
    return;
  }
  chatItemsByPane.clear();
  resetWorkingProgress();
  toolCardStateBySession.clear();
  expandedUserMessagesBySession.clear();
}

type ReplySource = MessageGroup["replyToMessage"];

function sameReplySource(previous: ReplySource, next: ReplySource): boolean {
  return previous?.key === next?.key && previous?.message === next?.message;
}

function sameMessageGroup(previous: MessageGroup, next: MessageGroup): boolean {
  // Source message identity owns the row timestamp too: normalization supplies
  // Date.now() for missing timestamps, which must not churn stable rows.
  return (
    previous.role === next.role &&
    previous.senderLabel === next.senderLabel &&
    sameFields(previous.senderSession, next.senderSession, CHAT_ITEM_FIELDS.senderSession) &&
    messageClientSourcesKey(previous.sourceClients ?? []) ===
      messageClientSourcesKey(next.sourceClients ?? []) &&
    JSON.stringify(previous.sender) === JSON.stringify(next.sender) &&
    JSON.stringify(previous.replyToSender) === JSON.stringify(next.replyToSender) &&
    sameReplySource(previous.replyToMessage, next.replyToMessage) &&
    previous.replyShared === next.replyShared &&
    sameReplySource(previous.replyTurnSource, next.replyTurnSource) &&
    sameReplySource(previous.replyCurrentSource, next.replyCurrentSource) &&
    previous.isStreaming === next.isStreaming &&
    previous.visibleContent === next.visibleContent &&
    previous.runId === next.runId &&
    previous.messages.length === next.messages.length &&
    previous.messages.every((entry, index) => {
      const candidate = next.messages[index];
      return (
        candidate !== undefined &&
        entry.key === candidate.key &&
        entry.message === candidate.message &&
        entry.duplicateCount === candidate.duplicateCount &&
        JSON.stringify(entry.replyTarget) === JSON.stringify(candidate.replyTarget) &&
        entry.hasVisibleContent === candidate.hasVisibleContent
      );
    })
  );
}

const CHAT_ITEM_FIELDS = {
  message: ["message", "duplicateCount"],
  notice: ["text", "label", "handoffBoundary", "startsTurn", "boundaryId", "timestamp"],
  divider: ["compaction", "compactionId", "label", "metric", "description", "timestamp"],
  question: ["questionId", "startedAt"],
  senderSession: ["sessionKey", "agentId", "label"],
} as const;

function sameFields<T extends object>(
  previous: T | null | undefined,
  next: T | null | undefined,
  fields: readonly (keyof T)[],
): boolean {
  return fields.every((field) => previous?.[field] === next?.[field]);
}

function sameChatItem(previous: RenderChatItem, next: RenderChatItem): boolean {
  if (previous.kind !== next.kind || previous.key !== next.key) {
    return false;
  }
  switch (next.kind) {
    case "group":
      return previous.kind === "group" && sameMessageGroup(previous, next);
    case "message":
      return previous.kind === "message" && sameFields(previous, next, CHAT_ITEM_FIELDS.message);
    case "notice":
      return previous.kind === "notice" && sameFields(previous, next, CHAT_ITEM_FIELDS.notice);
    case "divider":
      return previous.kind === "divider" && sameFields(previous, next, CHAT_ITEM_FIELDS.divider);
    case "stream":
      return (
        previous.kind === "stream" &&
        previous.text === next.text &&
        previous.startedAt === next.startedAt &&
        previous.isStreaming === next.isStreaming &&
        JSON.stringify(previous.replyToSender) === JSON.stringify(next.replyToSender) &&
        sameReplySource(previous.replyToMessage, next.replyToMessage) &&
        previous.runId === next.runId &&
        previous.boundaryId === next.boundaryId
      );
    case "reading-indicator":
      return (
        previous.kind === "reading-indicator" &&
        previous.startedAt === next.startedAt &&
        previous.waitingOn === next.waitingOn &&
        previous.request?.askedAt === next.request?.askedAt &&
        previous.request?.runIds.join("\n") === next.request?.runIds.join("\n") &&
        previous.runId === next.runId &&
        previous.boundaryId === next.boundaryId
      );
    case "question":
      return previous.kind === "question" && sameFields(previous, next, CHAT_ITEM_FIELDS.question);
  }
  return false;
}

function stabilizeChatItems(
  previous: ReturnType<typeof buildChatItems>,
  next: ReturnType<typeof buildChatItems>,
): ReturnType<typeof buildChatItems> {
  if (previous.length === 0 || next.length === 0) {
    return next;
  }
  // Same-role groups can grow at either edge. Preserve the existing row key
  // when loaded-history arrays retain message objects across prepend or append.
  const previousGroupByMessage = new WeakMap<object, MessageGroup>();
  const previousGroupByMessageKey = new Map<string, MessageGroup>();
  for (const item of previous) {
    if (item.kind !== "group") {
      continue;
    }
    for (const message of item.messages) {
      if (message.message && typeof message.message === "object") {
        previousGroupByMessage.set(message.message, item);
      }
      previousGroupByMessageKey.set(message.key, item);
    }
  }
  const nextNaturalGroupKeys = new Set(
    next.filter((item) => item.kind === "group").map((item) => item.key),
  );
  const claimedGroupKeys = new Set<string>();
  const previousCompactions = new Map(
    previous.flatMap((item) =>
      item.kind === "divider" && item.compactionId ? [[item.compactionId, item.key] as const] : [],
    ),
  );
  const reconciled = next.map((item) => {
    if (item.kind === "divider" && item.compactionId) {
      const key = previousCompactions.get(item.compactionId);
      return key ? { ...item, key } : item;
    }
    if (item.kind !== "group") {
      return item;
    }
    const candidates = new Map<MessageGroup, { overlap: number; lastMatchIndex: number }>();
    for (const [index, message] of item.messages.entries()) {
      const prior =
        message.message && typeof message.message === "object"
          ? (previousGroupByMessage.get(message.message) ??
            previousGroupByMessageKey.get(message.key))
          : previousGroupByMessageKey.get(message.key);
      if (
        !prior ||
        claimedGroupKeys.has(prior.key) ||
        prior.role !== item.role ||
        prior.runId !== item.runId ||
        prior.senderLabel !== item.senderLabel ||
        !sameFields(prior.senderSession, item.senderSession, CHAT_ITEM_FIELDS.senderSession) ||
        messageClientSourcesKey(prior.sourceClients ?? []) !==
          messageClientSourcesKey(item.sourceClients ?? []) ||
        senderIdentityKey(prior.sender) !== senderIdentityKey(item.sender)
      ) {
        continue;
      }
      const candidate = candidates.get(prior);
      candidates.set(prior, {
        overlap: (candidate?.overlap ?? 0) + 1,
        lastMatchIndex: index,
      });
    }
    let best: { group: MessageGroup; overlap: number; lastMatchIndex: number } | null = null;
    for (const [group, candidate] of candidates) {
      if (
        !best ||
        candidate.overlap > best.overlap ||
        (candidate.overlap === best.overlap && candidate.lastMatchIndex > best.lastMatchIndex)
      ) {
        best = { group, ...candidate };
      }
    }
    if (!best) {
      return item;
    }
    if (best.group.key !== item.key && nextNaturalGroupKeys.has(best.group.key)) {
      return item;
    }
    claimedGroupKeys.add(best.group.key);
    return item.key === best.group.key ? item : { ...item, key: best.group.key };
  });
  const previousByKey = new Map(previous.map((item) => [`${item.kind}\u0000${item.key}`, item]));
  const stabilized = reconciled.map((item) => {
    const prior = previousByKey.get(`${item.kind}\u0000${item.key}`);
    return prior && sameChatItem(prior, item) ? prior : item;
  });
  return sameEntries(stabilized, previous) ? previous : stabilized;
}

function sameEntries<T>(previous?: readonly T[], next?: readonly T[]): boolean {
  return (
    previous === next ||
    (previous !== undefined &&
      next !== undefined &&
      previous.length === next.length &&
      previous.every((entry, index) => entry === next[index]))
  );
}

function sameChatItemsStructuralInput(
  previous: BuildChatItemsProps,
  next: BuildChatItemsProps,
): boolean {
  return (
    previous.sessionKey === next.sessionKey &&
    previous.archiveNotice?.key === next.archiveNotice?.key &&
    previous.archiveNotice?.label === next.archiveNotice?.label &&
    previous.runId === next.runId &&
    previous.compactionStatus === next.compactionStatus &&
    previous.locale === next.locale &&
    previous.messages === next.messages &&
    previous.toolMessages === next.toolMessages &&
    previous.guardianNotices === next.guardianNotices &&
    previous.streamSegments === next.streamSegments &&
    previous.streamStartedAt === next.streamStartedAt &&
    previous.queue === next.queue &&
    previous.initialTurnId === next.initialTurnId &&
    // renderChat derives this list of immutable Gateway records on every render,
    // including scroll-driven ones; identity would rebuild all loaded history.
    sameEntries(previous.pendingInputs, next.pendingInputs) &&
    previous.workspaceSyncPendingRunIds === next.workspaceSyncPendingRunIds &&
    previous.workerSetupPending === next.workerSetupPending &&
    previous.showToolCalls === next.showToolCalls &&
    previous.persistCommentary === next.persistCommentary &&
    previous.runWorking === next.runWorking &&
    previous.runActive === next.runActive &&
    previous.subagentWait?.startedAt === next.subagentWait?.startedAt &&
    previous.subagentWait?.runId === next.subagentWait?.runId &&
    (previous.subagentWait === undefined) === (next.subagentWait === undefined) &&
    previous.questionPrompts === next.questionPrompts &&
    previous.loading === next.loading &&
    sameEntries(previous.replyPeople, next.replyPeople) &&
    previous.replyLocalPerson === next.replyLocalPerson &&
    previous.searchOpen === next.searchOpen &&
    previous.searchQuery === next.searchQuery &&
    previous.messageRecovery?.messages === next.messageRecovery?.messages &&
    previous.messageRecovery?.revision === next.messageRecovery?.revision &&
    previous.messageRecovery?.agentId === next.messageRecovery?.agentId
  );
}

function liveStreamIdentity(input: BuildChatItemsProps): string {
  return JSON.stringify([input.sessionKey, input.runId ?? null, input.streamStartedAt]);
}

function updateCachedLiveStream(cached: CachedChatItems, input: BuildChatItemsProps): boolean {
  const live = cached.liveStream;
  const item = live ? cached.items[live.index] : undefined;
  if (
    input.stream === null ||
    !live ||
    item?.kind !== "stream" ||
    !item.isStreaming ||
    live.identity !== liveStreamIdentity(input)
  ) {
    return false;
  }
  const text = trimAccumulatedStreamPrefix(sanitizeStreamText(input.stream), live.prefix);
  if (text.length === 0 || stripHeartbeatTokenForDisplay(text).shouldSkip) {
    return false;
  }
  cached.items[live.index] = { ...item, text };
  return true;
}

export function findLiveStreamIndex(items: readonly RenderChatItem[]): number {
  return items.findIndex((item) => item.kind === "stream" && item.isStreaming);
}

export function getChatItemsGeneration(items: readonly RenderChatItem[]): number {
  return chatItemsGenerations.get(items) ?? 0;
}

export function buildCachedChatItems(
  input: BuildChatItemsProps,
  projection: ChatItemsProjection = "visible",
): ReturnType<typeof buildChatItems> {
  let paneCache = chatItemsByPane.get(input.paneId);
  if (!paneCache) {
    paneCache = new Map();
    chatItemsByPane.set(input.paneId, paneCache);
  }
  const projections = getOrCreateSessionCacheValue(
    paneCache,
    input.sessionKey,
    (): CachedChatProjections => ({
      inputOrder: { keys: [] },
      initialTurnId: input.initialTurnId,
    }),
  );
  if (projections.initialTurnId !== input.initialTurnId) {
    projections.initialTurnId = input.initialTurnId;
    projections.inputOrder.keys = [];
    // Retiring the initial input resets both views of that ordering ledger.
    for (const cached of [projections.visible, projections.unfiltered]) {
      if (cached) {
        cached.input = null;
      }
    }
  }
  const cached = (projections[projection] ??= {
    generation: 0,
    input: null,
    items: [],
    liveStream: null,
  });
  // Keep stream-only updates off the loaded-history path; structural changes
  // still use the full builder.
  if (cached.input && sameChatItemsStructuralInput(cached.input, input)) {
    if (cached.input.stream === input.stream) {
      return cached.items;
    }
    if (cached.input.stream !== null && updateCachedLiveStream(cached, input)) {
      cached.input = input;
      return cached.items;
    }
  }
  const items = stabilizeChatItems(cached.items, buildChatItems(input, projections.inputOrder));
  // A rebuild can retain every row and the array. Consumers still need to
  // observe the structural pass; text-only slot replacements do not advance it.
  chatItemsGenerations.set(items, ++cached.generation);
  cached.input = input;
  cached.items = items;
  const liveStreamIndex = findLiveStreamIndex(items);
  cached.liveStream =
    liveStreamIndex < 0
      ? null
      : {
          index: liveStreamIndex,
          identity: liveStreamIdentity(input),
          prefix: accumulatedStreamText(input.streamSegments, sanitizeStreamText),
        };
  return items;
}

export function getExpansionStateVersion(values: ReadonlyMap<string, unknown>): number {
  return expansionMapVersions.get(values) ?? 0;
}

export function setExpansionState<T>(values: Map<string, T>, key: string, value: T): void {
  if (values.has(key) && values.get(key) === value) {
    return;
  }
  values.set(key, value);
  expansionMapVersions.set(values, getExpansionStateVersion(values) + 1);
}

function deleteExpansionState<T>(values: Map<string, T>, key: string): void {
  if (values.delete(key)) {
    expansionMapVersions.set(values, getExpansionStateVersion(values) + 1);
  }
}

export function pruneAssistantMessageExpansions(
  expanded: Map<string, AssistantMessageExpansionState>,
  agentId: string | undefined,
  sourceMessages: readonly unknown[],
): void {
  // Search and virtualization only hide rows. Prune against source history so
  // a removed message retires its body/load without refetching hidden rows.
  const retainedKeys = new Set(
    sourceMessages
      .map((message) => readChatThreadMessageIdentity(message)?.id)
      .filter((id): id is string => typeof id === "string")
      .map((id) => messageRecoveryKey(agentId, id)),
  );
  for (const key of expanded.keys()) {
    if (!retainedKeys.has(key)) {
      deleteExpansionState(expanded, key);
    }
  }
}

function getToolCardExpansionState(sessionKey: string): ToolCardExpansionState {
  // Expansion choices, initialization, and memoization share one eviction boundary.
  return getOrCreateSessionCacheValue(toolCardStateBySession, sessionKey, () => ({
    expanded: new Map(),
    initialized: new Set(),
  }));
}

export function getExpandedToolCards(sessionKey: string): Map<string, boolean> {
  return getToolCardExpansionState(sessionKey).expanded;
}

export function getExpandedUserMessages(sessionKey: string): Map<string, boolean> {
  for (const [cachedKey, state] of expandedUserMessagesBySession) {
    if (areUiSessionKeysEquivalent(cachedKey, sessionKey)) {
      if (cachedKey !== sessionKey) {
        expandedUserMessagesBySession.delete(cachedKey);
        setSessionCacheValue(expandedUserMessagesBySession, sessionKey, state);
      }
      return state;
    }
  }
  return getOrCreateSessionCacheValue(expandedUserMessagesBySession, sessionKey, () => new Map());
}

/**
 * A run that ends or hands off swaps its live tool rows for their stored
 * copies, which arrive under other message keys. Disclosure ids stay scoped to
 * their message, so what the reader had opened is carried across by tool call,
 * and only where one disclosure names that call on each side.
 */
function carryMovedDisclosures(
  expanded: Map<string, boolean>,
  previous: ReadonlyMap<string, string> | undefined,
  current: ReadonlyMap<string, string>,
): void {
  if (!previous) {
    return;
  }
  const single = (calls: ReadonlyMap<string, string>) => {
    const ids = new Map<string, string | null>();
    for (const [id, call] of calls) {
      ids.set(call, ids.has(call) ? null : id);
    }
    return ids;
  };
  const targets = single(current);
  for (const [call, source] of single(previous)) {
    const target = targets.get(call);
    const open = source ? expanded.get(source) : undefined;
    if (!source || !target || current.has(source) || open === undefined) {
      continue;
    }
    setExpansionState(expanded, target, open);
    if (source.startsWith("activity:")) {
      // Group choices are not pruned with their tool rows.
      deleteExpansionState(expanded, source);
    }
  }
}

export function syncToolCardExpansionState(
  sessionKey: string,
  items: readonly (ChatItem | MessageGroup)[],
  autoExpandToolCalls: boolean,
  isFilteredProjection = false,
): void {
  const state = getToolCardExpansionState(sessionKey);
  const { expanded, initialized, lastSync } = state;
  if (
    lastSync?.items.deref() === items &&
    lastSync.isFilteredProjection === isFilteredProjection &&
    lastSync.autoExpandToolCalls === autoExpandToolCalls
  ) {
    return;
  }
  const currentToolCardIds = new Set<string>();
  const calls = new Map<string, string>();
  const retainDisclosure = (id: string, callId: string | undefined, kind: string) => {
    currentToolCardIds.add(id);
    if (callId) {
      calls.set(id, `${kind}:${callId}`);
    }
    if (!initialized.has(id)) {
      setExpansionState(expanded, id, autoExpandToolCalls);
      initialized.add(id);
    }
  };
  for (const item of items) {
    if (item.kind !== "group") {
      continue;
    }
    let groupCallId: string | undefined;
    for (const entry of item.messages) {
      const cards = extractToolCardsCached(entry.message);
      for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
        groupCallId ??= cards[cardIndex]?.callId;
        retainDisclosure(`${entry.key}:toolcard:${cardIndex}`, cards[cardIndex]?.callId, "card");
      }
      if (!isStandaloneToolMessageForDisplay(entry.message)) {
        continue;
      }
      retainDisclosure(`toolmsg:${entry.key}`, cards[0]?.callId, "message");
    }
    if (groupCallId) {
      calls.set(`activity:${item.key}`, `activity:${groupCallId}`);
    }
  }
  if (!isFilteredProjection) {
    carryMovedDisclosures(expanded, state.calls, calls);
    state.calls = calls;
  }
  if (autoExpandToolCalls && !lastSync?.autoExpandToolCalls) {
    for (const toolCardId of initialized) {
      setExpansionState(expanded, toolCardId, true);
    }
  }
  // Search hides existing cards temporarily; pruning that projection would
  // discard the user's disclosure choice before the full transcript returns.
  if (!isFilteredProjection) {
    for (const disclosureId of initialized) {
      if (!currentToolCardIds.has(disclosureId)) {
        initialized.delete(disclosureId);
        deleteExpansionState(expanded, disclosureId);
      }
    }
  }
  state.lastSync = {
    items: new WeakRef(items),
    isFilteredProjection,
    autoExpandToolCalls,
  };
}
