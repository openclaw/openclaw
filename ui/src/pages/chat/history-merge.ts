import {
  createSessionProjection,
  readSessionMessageIdentity,
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionMessageEnvelope,
  type SessionMessageIdentity,
  type SessionProjectionEntry,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  type ApplicationChatSubmissions,
  type RetainedChatSubmission,
  retireInitialChatSubmission,
} from "../../app/chat-submissions.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import type { ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import {
  type ChatHistoryResidencyOwner,
  invalidateChatHistoryPacketSources,
  projectResidentChatHistory,
  publishResidentChatMessages,
} from "./chat-history-window.ts";
import { chatLocalOutputEntries } from "./chat-local-outputs.ts";
import { matchesCompactionOperation } from "./chat-progress.ts";
import {
  enrichChatProjectionEntries,
  projectionMessageEntries,
  retainsPairingQrScope,
  prepareChatProjectionMessages,
  retireChatProjectionPairingQr,
} from "./chat-projection-messages.ts";
import {
  CHAT_PROJECTION_SCOPE_KEYS,
  chatProjectionScopeChanged,
  readChatSessionProjectionScope,
} from "./chat-projection-scope.ts";
import { reconcileChatReasoning, type ChatReasoningHost } from "./chat-reasoning.ts";
import {
  isInitialSubmissionReceipt,
  readChatSubmissionBatch,
} from "./chat-submission-projection.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";
import type { CompactionStatus, ProviderPolicyNotice } from "./tool-stream-contract.ts";

export { readChatSessionProjectionScope } from "./chat-projection-scope.ts";

const chatSessionProjections = new WeakMap<
  object,
  {
    projection?: SessionProjectionState;
    runId?: string;
    readerSource?: string | null;
    publication?: symbol;
  }
>();
/** Opaque source custody contains scalar scope facts only, never retained transcript bodies. */
export type ChatHistoryStartCapability = { publication: symbol; scope: SessionProjectionScope };

export function readChatSessionPublication(owner: object): symbol {
  const current = chatSessionProjections.get(owner);
  if (current?.publication) {
    return current.publication;
  }
  const publication = Symbol("chat source publication");
  chatSessionProjections.set(owner, { ...current, publication });
  return publication;
}

function sameProjectionScope(left: SessionProjectionScope, right: SessionProjectionScope): boolean {
  return CHAT_PROJECTION_SCOPE_KEYS.every((key) => left[key] === right[key]);
}

type ChatSessionProjectionOwner = ChatHistoryResidencyOwner &
  ChatComposerScope &
  ChatReasoningHost & {
    sessionKey: string;
    chatMessages: unknown[];
    chatSubmissions?: ApplicationChatSubmissions;
    currentSessionId?: string | null;
    chatDisplayedLeafEntryId?: string | null;
    compactionStatus?: CompactionStatus | null;
    compactionClearTimer?: number | null;
    providerPolicyNotice?: ProviderPolicyNotice | null;
  };

function resetCompactionProjection(owner: ChatSessionProjectionOwner): void {
  if (owner.compactionClearTimer != null) {
    clearTimeout(owner.compactionClearTimer);
    owner.compactionClearTimer = null;
  }
  owner.compactionStatus = null;
}

function admitRetainedSteerProjection(
  owner: ChatSessionProjectionOwner,
  projection: SessionProjectionState,
): SessionProjectionState {
  const submissions = readChatSubmissionBatch(owner, projection.scope);
  let next = projection;
  for (const entry of projection.entries) {
    const runId = entry.identity?.sendId ?? entry.identity?.runId;
    if (!entry.pending && runId && submissions?.ownsPendingSteer(entry.identity)) {
      next = reduceSessionProjection(next, {
        type: "sendPending",
        runId,
        message: entry.message,
        scope: projection.scope,
      });
    }
  }
  return next;
}

/** One pane owns its shared-reducer projection; split panes never share live state. */
export function getChatSessionProjection(
  owner: ChatSessionProjectionOwner,
  scope: SessionProjectionScope = readChatSessionProjectionScope(owner),
  publicationReceipt?: { publication?: symbol },
): SessionProjectionState {
  const current = chatSessionProjections.get(owner)?.projection;
  const scopeChanged = current !== undefined && chatProjectionScopeChanged(current.scope, scope);
  if (scopeChanged) {
    // A scoped read can precede a history request. Only its accepted publication
    // switches the displayed transcript; a stale response cannot clear the pane.
    return createSessionProjection(scope);
  }
  if (!current) {
    const projection = admitRetainedSteerProjection(
      owner,
      createSessionProjection(scope, owner.chatMessages),
    );
    const publication = publishChatSessionProjection(owner, projection);
    if (publicationReceipt) {
      publicationReceipt.publication = publication;
    }
    return projection;
  }

  const bindsScope = CHAT_PROJECTION_SCOPE_KEYS.some(
    (key) =>
      Object.hasOwn(scope, key) && current.scope[key] === undefined && scope[key] !== undefined,
  );
  // Learning a durable session or leaf binds this pane without reclassifying
  // reducer-owned live entries, pending sends, or active runs as history.
  const scopedProjection = bindsScope
    ? { ...current, scope: { ...current.scope, ...scope } }
    : current;
  if (scopedProjection !== current) {
    const publication = publishChatSessionProjection(owner, scopedProjection);
    if (publicationReceipt) {
      publicationReceipt.publication = publication;
    }
  }
  return scopedProjection;
}

/** Inspect tentative admission custody without initializing or binding the pane. */
export const readChatSessionProjection = (owner: object): SessionProjectionState | undefined =>
  chatSessionProjections.get(owner)?.projection;

export function getChatRunProjection(owner: object, runId: string) {
  return chatSessionProjections.get(owner)?.projection?.runs[runId];
}

/** Compare semantic custody without initializing a projection or retaining its body. */
export function ownsChatSessionProjectionScope(
  owner: object,
  scope: SessionProjectionScope,
): boolean {
  const current = chatSessionProjections.get(owner)?.projection;
  return Boolean(current && sameProjectionScope(current.scope, scope));
}

/** Read existing custody without initializing or publishing during tentative admission. */
export function readChatLocalOutputEntries(owner: object): readonly SessionProjectionEntry[] {
  return chatLocalOutputEntries(chatSessionProjections.get(owner)?.projection?.entries);
}

export function readChatLocalOutputs(owner: object): readonly unknown[] {
  return readChatLocalOutputEntries(owner).map((entry) => entry.message);
}

export function getChatRunOwner(owner: object): string | undefined {
  return chatSessionProjections.get(owner)?.runId;
}

export function setChatRunOwner(
  owner: object & ChatReasoningHost,
  runId: string | undefined,
): void {
  if (runId && owner.chatReasoning?.runId !== runId) {
    owner.chatReasoning = null;
  }
  const current = chatSessionProjections.get(owner);
  chatSessionProjections.set(owner, {
    ...current,
    runId,
  });
}

function hasProjectionSessionKey(
  owner: Partial<ChatSessionProjectionOwner>,
): owner is Partial<ChatSessionProjectionOwner> & { sessionKey: string } {
  return typeof owner.sessionKey === "string";
}

/** Apply publication transforms before fitting, without initializing tentative custody. */
export function prepareChatHistoryProjectionMessages(
  owner: Partial<ChatSessionProjectionOwner>,
  messages: readonly unknown[],
  prospectiveScope?: SessionProjectionScope,
) {
  const current = chatSessionProjections.get(owner)?.projection;
  if (!current || !hasProjectionSessionKey(owner)) {
    return { messages, pins: [], changedSources: new Set<string>() };
  }
  const scope = prospectiveScope ?? readChatSessionProjectionScope(owner);
  const { messages: prepared, changedSources } = prepareChatProjectionMessages(
    current,
    messages,
    scope,
  );
  const pins = chatProjectionScopeChanged(current.scope, scope)
    ? []
    : reduceSessionProjection(current, {
        type: "residencyChanged",
        messages: [],
        pinnedRunIds: owner.lastLocalTerminalReconcile?.runId
          ? [owner.lastLocalTerminalReconcile.runId]
          : [],
      }).messages;
  return { messages: prepared, pins, changedSources };
}

/** The only mutation boundary for the reducer and its rendered message array. */
export function publishChatSessionProjection(
  owner: ChatSessionProjectionOwner,
  incomingProjection: SessionProjectionState,
  options: {
    retainPairingQr?: boolean;
    acceptedRunIds?: ReadonlySet<string>;
    awaitTranscriptReceipt?: boolean;
    localOutput?: boolean;
    sourceObserved?: boolean;
    custodyOnly?: boolean;
  } = {},
): symbol {
  const current = chatSessionProjections.get(owner);
  const preservesSource =
    !options.sourceObserved &&
    !options.acceptedRunIds?.size &&
    (incomingProjection === current?.projection ||
      (options.localOutput &&
        current?.projection &&
        sameProjectionScope(current.projection.scope, incomingProjection.scope)));
  const publication =
    preservesSource && current?.publication
      ? current.publication
      : Symbol("chat source publication");
  // Revoke before producer callbacks or residency can hide newly observed source facts.
  // Nested publication owns its newer token; the outer receipt retains only this token.
  chatSessionProjections.set(owner, { ...current, publication });
  let projection = incomingProjection;
  if (options.acceptedRunIds?.size) {
    // Accept producer custody before filtering resident bodies, but retire its
    // pending display in this same publication so paging never renders twice.
    projection = acceptChatSubmissionProjection(
      owner,
      projection,
      options.acceptedRunIds,
      options.awaitTranscriptReceipt,
    );
  }
  if (options.custodyOnly) {
    return publication;
  }
  const previous = current?.projection;
  if (
    options.retainPairingQr !== false &&
    previous &&
    previous.messages !== projection.messages &&
    retainsPairingQrScope(previous.scope, projection.scope)
  ) {
    // A leaf advance can still contain the same reply; never retain media across sessions.
    const enriched = enrichChatProjectionEntries(previous.entries, projection.entries);
    if (enriched) {
      if (owner.chatHistoryPagination) {
        owner.chatHistoryPagination = invalidateChatHistoryPacketSources(
          owner.chatHistoryPagination,
          enriched.changedSources,
        );
      }
      projection = { ...projection, entries: enriched.entries, messages: enriched.messages };
    }
  }
  const readerSource =
    previous && !chatProjectionScopeChanged(previous.scope, projection.scope)
      ? owner.readTranscriptReaderSnapshot?.()?.anchor
      : null;
  if (
    (owner.chatHistoryPagination?.segments ||
      projection.entries.some((entry) => entry.localOutput)) &&
    (previous?.messages !== projection.messages || current?.readerSource !== readerSource)
  ) {
    const admitted = projectResidentChatHistory(
      projection,
      owner.chatHistoryPagination ?? { hasMore: false },
      readerSource,
      owner.lastLocalTerminalReconcile?.runId,
    );
    projection = admitted.projection;
    owner.chatHistoryPagination = admitted.pagination;
  }
  const runId = current?.runId;
  const previousScope = current?.projection?.scope;
  const scopeChanged = previousScope && chatProjectionScopeChanged(previousScope, projection.scope);
  if (scopeChanged) {
    const status = owner.compactionStatus;
    const sessionChanged = chatProjectionScopeChanged(previousScope, projection.scope, [
      "sessionKey",
      "sessionId",
      "agentId",
    ]);
    if (sessionChanged) {
      owner.chatReasoning = null;
      owner.providerPolicyNotice = null;
    }
    // Appending the completed marker advances the active leaf. Retain its live
    // identity through that refresh, but never carry it into another session or branch.
    if (
      sessionChanged ||
      !status ||
      !projection.messages.some((message) => matchesCompactionOperation(message, status))
    ) {
      resetCompactionProjection(owner);
    }
  }
  const retainedRunId =
    runId && Object.hasOwn(projection.runs, runId) && !scopeChanged ? runId : undefined;
  chatSessionProjections.set(owner, {
    projection,
    runId: retainedRunId,
    readerSource,
    publication: chatSessionProjections.get(owner)?.publication ?? publication,
  });
  reconcileChatReasoning(owner, projection, current?.projection?.messages);
  // Run-only transitions share the transcript array. Preserve their ownership
  // updates above without traversing or republishing every displayed row.
  if (current?.projection?.messages !== projection.messages) {
    publishResidentChatMessages(owner, previous, projection);
  }
  return publication;
}

/** A retired connection cannot lend pairing credentials to its replacement's history. */
export function retireChatPairingQr(owner: ChatSessionProjectionOwner): void {
  publishChatSessionProjection(
    owner,
    retireChatProjectionPairingQr(getChatSessionProjection(owner)),
    { retainPairingQr: false },
  );
}

/** Publish one exact live transcript order without dropping reducer-owned entry identity. */
export function publishChatSessionProjectionMessages(
  owner: ChatSessionProjectionOwner,
  messages: readonly unknown[],
  options: {
    event?: SessionProjectionEvent;
    scope?: SessionProjectionScope;
    acceptedRunIds?: ReadonlySet<string>;
  } = {},
): SessionProjectionState {
  const scope = options.scope ?? readChatSessionProjectionScope(owner);
  const base = getChatSessionProjection(owner, scope);
  const current = options.event ? reduceSessionProjection(base, { ...options.event, scope }) : base;
  const eventMessage = options.event?.type === "messagePersisted" ? options.event.message : null;
  const currentMessages = new Set(current.messages);
  const supersededMessages = new Set(
    base.messages.filter((message) => !currentMessages.has(message)),
  );
  const eventAccepted = eventMessage === null || currentMessages.has(eventMessage);
  const acceptedMessages: unknown[] = [];
  let eventPublished = false;
  for (let message of messages) {
    if (supersededMessages.has(message)) {
      if (eventMessage === null) {
        continue;
      }
      message = eventMessage;
    }
    if (message === eventMessage) {
      if (!eventAccepted || eventPublished) {
        continue;
      }
      eventPublished = true;
    }
    acceptedMessages.push(message);
  }
  // Classify raw predecessor relationships once, then restore each existing
  // occurrence's live/pending provenance without changing presentation order.
  const entries = projectionMessageEntries(current, acceptedMessages);
  const projection: SessionProjectionState = {
    ...current,
    scope: { ...current.scope, ...scope },
    entries,
    messages: acceptedMessages,
  };
  publishChatSessionProjection(owner, projection, { acceptedRunIds: options.acceptedRunIds });
  return projection;
}

/** A custody or consumption receipt retires only an uncommitted local user source. */
export function reconcileChatInputCustody(
  owner: ChatSessionProjectionOwner,
  page: ChatPendingInputsPage | undefined,
  receipts: ChatInputReceipts = [],
) {
  const acceptedRunIds = new Set(
    [...(page?.items ?? []), ...receipts]
      .map((item) => item.runId)
      .filter((runId) => typeof runId === "string"),
  );
  // Display correlation may be omitted at the wire cap; positive custody still
  // revokes an earlier empty-source receipt before its last body can disappear.
  retireChatSubmissionDisplay(owner, acceptedRunIds, {
    awaitTranscriptReceipt: true,
    sourceObserved: Boolean(page?.total || page?.items.length || receipts.length),
  });
  // Deferred custody supersedes optimistic steering; acceptance alone does not.
  const retiredDisplayRunIds = new Set(
    [
      ...(page?.items ?? [])
        .filter((input) => input.state !== "queued" || input.queued)
        .map((input) => input.runId),
      ...receipts
        .filter((receipt) => receipt.state === "pending" && (receipt.cancelled || receipt.queued))
        .map((receipt) => receipt.runId),
    ].filter((runId) => typeof runId === "string"),
  );
  retireChatSubmissionDisplay(owner, retiredDisplayRunIds);
  return {
    acceptedRunIds,
    page: page ?? { items: [], total: 0 },
  };
}

/** Canonical custody retires local display ownership even outside the loaded history page. */
export function retireChatSubmissionDisplay(
  owner: ChatSessionProjectionOwner,
  acceptedRunIds: ReadonlySet<string>,
  options: { awaitTranscriptReceipt?: boolean; sourceObserved?: boolean } = {},
): void {
  if (!acceptedRunIds.size && !options.sourceObserved) {
    return;
  }
  const scope = readChatSessionProjectionScope(owner, {
    agentId: resolveUiSelectedSessionAgentId(owner),
  });
  const current = chatSessionProjections.get(owner)?.projection;
  const projection = getChatSessionProjection(owner, scope);
  publishChatSessionProjection(owner, projection, {
    acceptedRunIds,
    awaitTranscriptReceipt: options.awaitTranscriptReceipt,
    sourceObserved: options.sourceObserved,
    // get() returns a tentative projection on scope change. Custody acceptance
    // must not replace held display before an authoritative snapshot commits it.
    custodyOnly: current !== undefined && chatProjectionScopeChanged(current.scope, scope),
  });
}

function acceptChatSubmissionProjection(
  owner: ChatSessionProjectionOwner,
  projection: SessionProjectionState,
  acceptedRunIds: ReadonlySet<string>,
  awaitTranscriptReceipt = false,
): SessionProjectionState {
  readChatSubmissionBatch(owner, projection.scope)?.accept(acceptedRunIds, awaitTranscriptReceipt);
  return retirePendingUserEntries(projection, acceptedRunIds, awaitTranscriptReceipt);
}

function retirePendingUserEntries(
  projection: SessionProjectionState,
  acceptedRunIds: ReadonlySet<string>,
  awaitTranscriptReceipt = false,
): SessionProjectionState {
  const entries = projection.entries.filter(
    (entry) =>
      !(
        entry.pending &&
        entry.identity?.role === "user" &&
        !(awaitTranscriptReceipt && persistedSteerTargetRunId(entry.message)) &&
        entry.identity.id === null &&
        entry.identity.sequence === null &&
        acceptedRunIds.has(entry.pendingRunId ?? "")
      ),
  );
  return entries.length === projection.entries.length
    ? projection
    : { ...projection, entries, messages: entries.map((entry) => entry.message) };
}

export function shouldDisplayChatSubmission(
  submission: RetainedChatSubmission,
  receipt: SessionMessageIdentity | null,
): boolean {
  // A local copy suppresses display; only a durable receipt retires ownership.
  if (receipt && (receipt.id !== null || receipt.sequence !== null)) {
    if (submission.kind === "initial") {
      retireInitialChatSubmission(submission);
    } else {
      submission.pending = false;
    }
  }
  return submission.pending && !receipt;
}

/** A retained submission has display ownership only until its own user receipt or custody. */
export function admitChatSubmission(
  owner: ChatSessionProjectionOwner,
  pendingInputs: ChatPendingInputsPage["items"] | undefined,
  submission: RetainedChatSubmission | null | undefined = owner.chatSubmissions?.readInitial(
    owner.sessionKey,
    owner.client ?? null,
    owner.currentSessionId,
  ),
): boolean {
  // A pane can receive custody before the sender hands off its local display.
  if (
    submission &&
    (pendingInputs?.some(
      (input) =>
        input.runId === submission.pendingRunId &&
        (input.queued ||
          !(submission.kind === "delivered" && persistedSteerTargetRunId(submission.message))),
    ) ||
      (submission.kind === "initial" &&
        owner.chatMessages.some((message) =>
          isInitialSubmissionReceipt(submission, readSessionMessageIdentity(message)),
        )))
  ) {
    if (submission.kind === "initial") {
      retireInitialChatSubmission(submission);
    } else {
      submission.pending = false;
    }
  }
  if (
    !submission?.pending ||
    (submission.kind === "delivered" &&
      (!owner.chatSubmissions ||
        !shouldDisplayChatSubmission(
          submission,
          findChatSubmissionMessage(owner.chatMessages, submission.pendingRunId, true),
        )))
  ) {
    return false;
  }
  const scope = readChatSessionProjectionScope(owner, {
    sessionKey: submission.sessionKey,
    ...(submission.kind === "delivered" ? { agentId: submission.agentId } : {}),
  });
  const previousMessages = owner.chatMessages;
  reduceChatSessionProjection(
    owner,
    { type: "sendPending", runId: submission.pendingRunId, message: submission.message },
    { scope },
  );
  return owner.chatMessages !== previousMessages;
}

/** Publish the reducer and rendered transcript together; no caller maintains a second copy. */
export function reduceChatSessionProjection(
  owner: ChatSessionProjectionOwner,
  event: SessionProjectionEvent,
  options: {
    scope?: SessionProjectionScope;
    runActive?: boolean;
    messageReceipt?: { accepted: boolean };
    publicationReceipt?: {
      publication?: symbol;
      previousPublication?: symbol;
      uninterrupted?: boolean;
    };
    emptySource?: ChatHistoryStartCapability;
    /** Caller proved append continuity using the same read that supplies the new snapshot. */
    localOutputScope?: SessionProjectionScope;
  } = {},
): SessionProjectionState {
  const scope = options.scope ?? readChatSessionProjectionScope(owner);
  const previous = chatSessionProjections.get(owner)?.projection;
  const previousPublication = readChatSessionPublication(owner);
  const bindingReceipt: { publication?: symbol } = {};
  let current = getChatSessionProjection(owner, scope, bindingReceipt);
  const inputPublication = bindingReceipt.publication ?? previousPublication;
  if (
    event.type === "snapshotLoaded" &&
    options.localOutputScope &&
    previous &&
    chatProjectionScopeChanged(previous.scope, scope) &&
    ownsChatSessionProjectionScope(owner, options.localOutputScope)
  ) {
    // Transfer only current typed local custody. Old native rows and packets
    // never cross a leaf change merely because their anchor is still visible.
    const entries = previous.entries.filter((entry) => entry.localOutput);
    current = { ...current, entries, messages: entries.map((entry) => entry.message) };
  }
  const submissions = readChatSubmissionBatch(owner, scope);
  const handoff = submissions?.initial;
  const initialRunId = handoff?.pending ? handoff.pendingRunId : undefined;
  const initialMessage = handoff?.pending ? handoff.message : null;
  const receive = (message: unknown, envelope?: SessionMessageEnvelope) =>
    submissions
      ? submissions.receive(
          message,
          readSessionMessageIdentity(message, envelope),
          Boolean(envelope),
        )
      : message;
  const preparedEvent =
    event.type === "messagePersisted" && submissions
      ? { ...event, message: receive(event.message, event.envelope ?? event) }
      : event.type === "snapshotLoaded" && submissions
        ? {
            ...event,
            messages: event.messages
              .map((message) => receive(message))
              .filter((message) => message !== undefined),
          }
        : event;
  let projection =
    initialRunId && handoff && !handoff.pending
      ? retirePendingUserEntries(current, new Set([initialRunId]))
      : current;
  if (event.type === "snapshotLoaded" && handoff?.pending && options.runActive !== false) {
    projection = reduceSessionProjection(projection, {
      type: "sendPending",
      runId: handoff.pendingRunId,
      message: handoff.message,
      scope,
    });
  }
  const admittedEvent =
    preparedEvent.type === "localOutput"
      ? {
          ...preparedEvent,
          sourceEmpty:
            options.emptySource &&
            options.emptySource.publication === readChatSessionPublication(owner) &&
            sameProjectionScope(options.emptySource.scope, projection.scope)
              ? (true as const)
              : undefined,
        }
      : preparedEvent;
  projection = reduceSessionProjection(projection, { ...admittedEvent, scope });
  if (options.messageReceipt && preparedEvent.type === "messagePersisted") {
    // Persistence acceptance precedes residency filtering. Stream cleanup must
    // not depend on whether the accepted durable row remains on screen.
    options.messageReceipt.accepted = projection.messages.includes(preparedEvent.message);
  }
  if (event.type === "snapshotLoaded") {
    projection = admitRetainedSteerProjection(owner, projection);
  }
  if (event.type === "sessionReset" && projection !== current) {
    submissions?.accept(
      new Set(
        current.entries.flatMap((entry) =>
          entry.pendingRunId && persistedSteerTargetRunId(entry.message)
            ? [entry.pendingRunId]
            : [],
        ),
      ),
    );
    owner.chatReasoning = null;
    delete owner.chatHistoryCursor;
    // Reset starts a new transcript epoch. Retained display rows do not carry
    // the old source membership, packet certificates, or opaque edges into it.
    owner.chatHistoryPagination = { hasMore: false };
    resetCompactionProjection(owner);
    owner.providerPolicyNotice = null;
  }
  // Without a transcript anchor this is best-effort display chronology, assuming
  // comparable browser/Gateway clocks. Never assign a sequence or reorder canonical
  // rows; older or untimestamped history stays ahead until authoritative adoption.
  const initialIndex = initialRunId
    ? projection.entries.findIndex((entry) => entry.pending && entry.pendingRunId === initialRunId)
    : -1;
  const initial = projection.entries[initialIndex];
  if (handoff && initialMessage && initial && initialIndex > 0) {
    const outputIndex = projection.entries.findIndex((entry, index) => {
      const message = asNullableRecord(entry.message);
      return (
        index < initialIndex &&
        message?.role !== "user" &&
        typeof message?.timestamp === "number" &&
        message.timestamp >= initialMessage.timestamp
      );
    });
    if (outputIndex >= 0) {
      const entries = projection.entries.toSpliced(initialIndex, 1);
      entries.splice(outputIndex, 0, initial);
      projection = { ...projection, entries, messages: entries.map((entry) => entry.message) };
    }
  }
  const uninterrupted = inputPublication === readChatSessionPublication(owner);
  const publication = publishChatSessionProjection(owner, projection, {
    localOutput: event.type === "localOutput",
  });
  if (options.publicationReceipt) {
    Object.assign(options.publicationReceipt, { publication, previousPublication, uninterrupted });
  }
  return projection;
}
