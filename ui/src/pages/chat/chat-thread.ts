import { messageClientSourcesKey } from "../../../../src/chat/message-client-source.js";
import {
  accumulatedStreamText,
  trimAccumulatedStreamPrefix,
  type ChatItem,
  type MessageGroup,
} from "../../lib/chat/chat-types.ts";
import { stripHeartbeatTokenForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { readChatThreadMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import { isStandaloneToolMessageForDisplay } from "../../lib/chat/message-normalizer.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import type { InlineCommandDisclosurePolicy } from "./chat-inline-command-presentation.ts";
import {
  messageRecoveryKey,
  type AssistantMessageExpansionState,
} from "./chat-message-recovery.ts";
import { resetWorkingProgress } from "./chat-progress.ts";
import { activeChatReasoning } from "./chat-reasoning.ts";
import type { SystemEventRenderItem } from "./chat-system-event-grouping.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { collectOwnedCanvasPreviews, stripOwnedCanvasShortcodes } from "./chat-thread-canvas.ts";
import type { ChatItemsFacts } from "./chat-thread-facts.ts";
import { sameChatItemsStructuralInput, sameEntries } from "./chat-thread-input-match.ts";
import type { ChatInputOrderState } from "./chat-thread-inputs.ts";
import { sanitizeStreamText } from "./chat-thread-items.ts";
import type { PrependFacts } from "./chat-thread-prepend.ts";
import { carryMovedDisclosures } from "./chat-tool-activity-coalesce.ts";
import { getOrCreateSessionCacheValue, setSessionCacheValue } from "./session-cache.ts";

type CachedChatItems = {
  generation: number;
  input: BuildChatItemsProps | null;
  items: ReturnType<typeof buildChatItems>;
  liveStream: {
    index: number;
    /** Before first text, the builder's seed occupies the indicator's insertion slot. */
    onset?: Extract<ChatItem, { kind: "stream" }>;
    identity: string;
    prefix: string | null;
    ownedCanvas: ReturnType<typeof collectOwnedCanvasPreviews>;
  } | null;
  /** Facts of the history behind items. */
  facts?: PrependFacts;
};

type RenderChatItem = ReturnType<typeof buildChatItems>[number];

type PrependRuntime = Awaited<ReturnType<typeof importPrependRuntime>>;
let prependRuntime: PrependRuntime | undefined;
let prependLoading: Promise<unknown> | undefined;

async function importPrependRuntime() {
  const { prependOlderChatItems } = await import("./chat-thread-prepend.ts");
  return { prependOlderChatItems };
}

/** Older-page reuse stays out of chat boot; prepends take the full build until it loads. */
function loadedPrependRuntime() {
  prependLoading ??= importPrependRuntime().then(
    (loaded) => (prependRuntime = loaded),
    () => (prependLoading = undefined),
  );
  return prependRuntime;
}

type ToolCardExpansionState = {
  expanded: Map<string, boolean>;
  // Group disclosures share the map but must stay outside tool-only auto-expand and pruning.
  initialized: Set<string>;
  explicit: Set<string>;
  /** The tool call behind each disclosure of the last complete projection. */
  calls?: Map<string, string>;
  lastSync?: {
    // The scan memo must not retain messages after their owning pane releases them.
    items: WeakRef<readonly RenderChatItem[]>;
    transcriptItems?: WeakRef<readonly SystemEventRenderItem[]>;
    bubbleMode: boolean;
    isFilteredProjection: boolean;
    autoExpandToolCalls: boolean;
    inlineCommands: InlineCommandDisclosurePolicy | undefined;
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
const expansionListeners = new WeakMap<ReadonlyMap<string, unknown>, Set<() => void>>();
const explicitToolExpansions = new WeakMap<ReadonlyMap<string, unknown>, Set<string>>();

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
    previous.replyPreviousMessageId === next.replyPreviousMessageId &&
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
        JSON.stringify(entry.replyTarget) === JSON.stringify(candidate.replyTarget) &&
        entry.hasVisibleContent === candidate.hasVisibleContent
      );
    })
  );
}

const CHAT_ITEM_FIELDS = {
  message: ["message"],
  notice: [
    "text",
    "label",
    "handoffBoundary",
    "startsTurn",
    "boundaryId",
    "timestamp",
    "systemEvent",
    "repeatCount",
  ],
  divider: [
    "compaction",
    "compactionId",
    "label",
    "metric",
    "description",
    "timestamp",
    "systemEvent",
  ],
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
      return (
        previous.kind === "notice" &&
        sameFields(previous, next, CHAT_ITEM_FIELDS.notice) &&
        sameFields(previous.modelChange, next.modelChange, ["from", "to"])
      );
    case "divider":
      return previous.kind === "divider" && sameFields(previous, next, CHAT_ITEM_FIELDS.divider);
    case "stream":
      return (
        previous.kind === "stream" &&
        previous.text === next.text &&
        previous.thinking === next.thinking &&
        previous.startedAt === next.startedAt &&
        previous.isStreaming === next.isStreaming &&
        JSON.stringify(previous.replyToSender) === JSON.stringify(next.replyToSender) &&
        sameReplySource(previous.replyToMessage, next.replyToMessage) &&
        previous.replyPreviousMessageId === next.replyPreviousMessageId &&
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

function liveStreamIdentity(input: BuildChatItemsProps): string {
  return JSON.stringify([input.sessionKey, input.runId ?? null, input.streamStartedAt]);
}

function updateCachedLiveStream(cached: CachedChatItems, input: BuildChatItemsProps): boolean {
  const reasoning = activeChatReasoning(input.reasoning);
  const live = cached.liveStream;
  const item = live?.onset ?? (live ? cached.items[live.index] : undefined);
  if (
    (input.stream === null && !reasoning) ||
    !live ||
    item?.kind !== "stream" ||
    !item.isStreaming ||
    live.identity !== liveStreamIdentity(input)
  ) {
    return false;
  }
  const text = stripOwnedCanvasShortcodes(
    trimAccumulatedStreamPrefix(sanitizeStreamText(input.stream ?? ""), live.prefix),
    item.runId,
    live.ownedCanvas,
  );
  if (!reasoning && (text.length === 0 || stripHeartbeatTokenForDisplay(text).shouldSkip)) {
    return false;
  }
  const next = { ...item, text, thinking: reasoning?.text };
  if (live.onset) {
    // Keep the prior projection intact while the new stream changes row membership.
    cached.items = cached.items.toSpliced(live.index, input.runFinalizing ? 1 : 0, next);
    live.onset = undefined;
    chatItemsGenerations.set(cached.items, ++cached.generation);
  } else {
    cached.items[live.index] = next;
  }
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
  const previousInput = cached.input;
  // The first answer also retires its working indicator; all other facts must match.
  const finalizingOnset =
    cached.liveStream?.onset &&
    previousInput !== null &&
    input.runWorking !== true &&
    input.runFinalizing === true &&
    input.runActive === true &&
    previousInput.stream !== input.stream;
  if (
    previousInput &&
    sameChatItemsStructuralInput(
      previousInput,
      input,
      finalizingOnset,
      cached.facts?.hasContentBeforeProgress,
    )
  ) {
    if (
      previousInput.stream === input.stream &&
      activeChatReasoning(previousInput.reasoning)?.text ===
        activeChatReasoning(input.reasoning)?.text
    ) {
      return cached.items;
    }
    if (updateCachedLiveStream(cached, input)) {
      cached.input = input;
      return cached.items;
    }
  }
  const previous = cached.input;
  const added = previous ? input.messages.length - previous.messages.length : 0;
  // Only a page in front of retained history loads the reuse runtime.
  const prepended =
    previous &&
    cached.facts &&
    added > 0 &&
    added < input.messages.length &&
    input.messages[added] === previous.messages[0] &&
    sameChatItemsStructuralInput(previous, { ...input, messages: previous.messages })
      ? loadedPrependRuntime()?.prependOlderChatItems(
          { messages: previous.messages, items: cached.items, facts: cached.facts },
          input,
          projections.inputOrder,
          sameChatItem,
        )
      : null;
  const facts: ChatItemsFacts = { firsts: new Map(), indexedDividers: [] };
  const items = prepended
    ? [
        ...stabilizeChatItems(cached.items.slice(0, prepended.retainedFrom), prepended.head),
        ...cached.items.slice(prepended.retainedFrom),
      ]
    : stabilizeChatItems(
        cached.items,
        buildChatItems(input, projections.inputOrder, "transcript", facts),
      );
  cached.facts = prepended?.facts ?? facts;
  // A rebuild can retain every row and the array. Consumers still need to
  // observe the structural pass; text-only slot replacements do not advance it.
  chatItemsGenerations.set(items, ++cached.generation);
  cached.input = input;
  cached.items = items;
  const onset = cached.facts.streamOnset;
  const liveStreamIndex = onset
    ? items.findIndex((item) => item.kind === "reading-indicator" && item.key === onset.key)
    : findLiveStreamIndex(items);
  cached.liveStream =
    liveStreamIndex < 0
      ? null
      : {
          index: liveStreamIndex,
          onset,
          identity: liveStreamIdentity(input),
          prefix: accumulatedStreamText(input.streamSegments, sanitizeStreamText),
          ownedCanvas: collectOwnedCanvasPreviews(items),
        };
  return items;
}

export function getExpansionStateVersion(values: ReadonlyMap<string, unknown>): number {
  return expansionMapVersions.get(values) ?? 0;
}

export function subscribeExpansionState(
  values: ReadonlyMap<string, unknown>,
  notify: () => void,
): () => void {
  const listeners = expansionListeners.get(values) ?? new Set<() => void>();
  expansionListeners.set(values, listeners);
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

function writeExpansionState<T>(
  values: Map<string, T>,
  key: string,
  value: T,
  explicit = false,
): boolean {
  const choices = explicitToolExpansions.get(values);
  const newChoice = explicit && choices !== undefined && !choices.has(key);
  if (!newChoice && values.has(key) && values.get(key) === value) {
    return false;
  }
  if (newChoice) {
    choices.add(key);
  }
  values.set(key, value);
  expansionMapVersions.set(values, getExpansionStateVersion(values) + 1);
  return true;
}

export function setExpansionState<T>(values: Map<string, T>, key: string, value: T): void {
  if (writeExpansionState(values, key, value, true)) {
    for (const notify of expansionListeners.get(values) ?? []) {
      notify();
    }
  }
}

export function toggleExpansionState(
  values: Map<string, boolean>,
  key: string,
  expanded = values.get(key) ?? false,
): void {
  setExpansionState(values, key, !expanded);
}

export function getExplicitToolExpansion(values: ReadonlyMap<string, boolean>, key: string) {
  return explicitToolExpansions.get(values)?.has(key) ? values.get(key) : undefined;
}

function deleteExpansionState<T>(values: Map<string, T>, key: string): void {
  const previous = values.get(key);
  if (values.delete(key)) {
    if (previous !== false) {
      expansionMapVersions.set(values, getExpansionStateVersion(values) + 1);
    }
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
  return getOrCreateSessionCacheValue(toolCardStateBySession, sessionKey, () => {
    const expanded = new Map<string, boolean>();
    const explicit = new Set<string>();
    explicitToolExpansions.set(expanded, explicit);
    return { expanded, initialized: new Set(), explicit };
  });
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

export function syncToolCardExpansionState(
  sessionKey: string,
  items: readonly (ChatItem | MessageGroup)[],
  autoExpandToolCalls: boolean,
  isFilteredProjection = false,
  inlineCommands?: InlineCommandDisclosurePolicy,
  transcriptItems?: readonly SystemEventRenderItem[],
  bubbleMode = false,
): void {
  const state = getToolCardExpansionState(sessionKey);
  const { expanded, initialized, explicit, lastSync } = state;
  if (
    lastSync?.items.deref() === items &&
    lastSync.isFilteredProjection === isFilteredProjection &&
    lastSync.autoExpandToolCalls === autoExpandToolCalls &&
    lastSync.inlineCommands === inlineCommands &&
    lastSync.transcriptItems?.deref() === transcriptItems &&
    lastSync.bubbleMode === bubbleMode
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
      if (!explicit.has(id)) {
        if (autoExpandToolCalls) {
          writeExpansionState(expanded, id, true);
        } else {
          // Closed is already the rendering default; discovering it changes only inventory.
          expanded.set(id, false);
        }
      }
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
        const card = cards[cardIndex]!;
        groupCallId ??= card.callId;
        retainDisclosure(`${entry.key}:toolcard:${cardIndex}`, card.callId, "card");
      }
      if (!isStandaloneToolMessageForDisplay(entry.message)) {
        continue;
      }
      retainDisclosure(`toolmsg:${entry.key}`, cards[0]?.callId, "message");
    }
    if (groupCallId && (!inlineCommands || !transcriptItems)) {
      calls.set(`activity:${item.key}`, `activity:${groupCallId}`);
    }
  }
  if (inlineCommands && transcriptItems) {
    for (const [id, call] of inlineCommands.inlineActivityDisclosureCalls(
      transcriptItems,
      bubbleMode,
    )) {
      calls.set(id, call);
    }
  }
  if (!isFilteredProjection) {
    carryMovedDisclosures(state, state.calls, calls, writeExpansionState);
    // Reconnect temporarily clears live rows before restoring stored history.
    // Keep their call associations with the explicit choices retained below.
    if (calls.size > 0) {
      state.calls = calls;
    }
  }
  if (autoExpandToolCalls && !lastSync?.autoExpandToolCalls) {
    for (const id of initialized) {
      if (!explicit.has(id)) {
        writeExpansionState(expanded, id, true);
      }
    }
  }
  // A render reconciles its own history without notifying sibling panes. Their
  // history windows can differ; explicit choices survive until session eviction.
  // Search also hides defaults temporarily, so it cannot prune them.
  if (!isFilteredProjection) {
    for (const disclosureId of initialized) {
      if (!currentToolCardIds.has(disclosureId) && !explicit.has(disclosureId)) {
        initialized.delete(disclosureId);
        deleteExpansionState(expanded, disclosureId);
      }
    }
  }
  state.lastSync = {
    items: new WeakRef(items),
    transcriptItems: transcriptItems ? new WeakRef(transcriptItems) : undefined,
    bubbleMode,
    isFilteredProjection,
    autoExpandToolCalls,
    inlineCommands,
  };
}
