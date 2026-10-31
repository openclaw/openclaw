import {
  createSessionProjection,
  readSessionMessageIdentity,
  reduceSessionProjection,
  type SessionMessageIdentity,
  type SessionProjectionEvent,
  type SessionMessageEnvelope,
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
import {
  findChatSubmissionMessage,
  nativeHistoryMessageSourceIdentity,
} from "../../lib/chat/history-message-identity.ts";
import { chatOutboxDeliveryKey, type ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import { removePairingQrContent, retainPairingQrEntries } from "../../lib/chat/pairing-qr.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import {
  type ChatHistoryResidencyOwner,
  invalidateChatHistoryPacketSources,
  projectResidentChatHistory,
  prepareChatHistoryRequestBudget,
  publishResidentChatMessages,
} from "./chat-history-window.ts";
import { chatLocalOutputEntries } from "./chat-local-outputs.ts";
import { matchesCompactionOperation } from "./chat-progress.ts";
import {
  CHAT_PROJECTION_SCOPE_KEYS,
  chatProjectionScopeChanged,
  readChatSessionProjectionScope,
} from "./chat-projection-scope.ts";
import { reconcileChatReasoning, type ChatReasoningHost } from "./chat-reasoning.ts";
import { persistedSteerTargetRunId } from "./stream-causal-boundary.ts";
import type { CompactionStatus, ProviderPolicyNotice } from "./tool-stream-contract.ts";

export { readChatSessionProjectionScope } from "./chat-projection-scope.ts";

const chatSessionProjections = new WeakMap<
  object,
  {
    projection?: SessionProjectionState;
    runId?: string;
    readerSource?: string | null;
  }
>();
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

function isInitialSubmissionReceipt(
  submission: RetainedChatSubmission | null | undefined,
  identity: SessionMessageIdentity | null,
): boolean {
  return (
    submission?.kind === "initial" &&
    identity?.role === "user" &&
    !identity.isImported &&
    (identity.id !== null || identity.sequence !== null) &&
    (identity.idempotencyKey === submission.pendingRunId ||
      identity.idempotencyKey === `${submission.pendingRunId}:user`)
  );
}

function readChatSubmissionBatch(owner: ChatSessionProjectionOwner, scope: SessionProjectionScope) {
  const submissions = owner.chatSubmissions;
  if (!submissions) {
    return undefined;
  }
  const sessionKey = scope.sessionKey ?? owner.sessionKey;
  const client = owner.client;
  const handoff = submissions.readInitial(sessionKey, client ?? null, scope.sessionId);
  // The pane captures one client and delivery key for the synchronous receipt batch.
  const key = chatOutboxDeliveryKey(owner, {
    sessionKey,
    agentId: scope.agentId ?? resolveUiSelectedSessionAgentId(owner),
  });
  const deliveredInScope = (runId: string) => {
    const entry = submissions.readDelivered(key + runId, client ?? owner);
    return entry?.kind === "delivered" &&
      (!entry.sessionId || !scope.sessionId || entry.sessionId === scope.sessionId)
      ? entry
      : undefined;
  };
  const retire = (runId: string, awaitTranscriptReceipt = false) => {
    const entry = deliveredInScope(runId);
    if (entry && !(awaitTranscriptReceipt && persistedSteerTargetRunId(entry.message))) {
      entry.pending = false;
    }
  };
  return {
    initial: handoff,
    accept: (runIds: ReadonlySet<string>, awaitTranscriptReceipt = false) => {
      runIds.forEach((runId) => retire(runId, awaitTranscriptReceipt));
      if (handoff && runIds.has(handoff.pendingRunId)) {
        retireInitialChatSubmission(handoff);
      }
    },
    ownsPendingSteer: (identity: SessionMessageIdentity | null) => {
      const runId = identity?.idempotencyKey?.replace(/:user$/u, "");
      const entry = runId ? deliveredInScope(runId) : undefined;
      return Boolean(
        identity?.role === "user" &&
        !identity.isImported &&
        identity.id === null &&
        identity.sequence === null &&
        entry?.pending &&
        persistedSteerTargetRunId(entry.message),
      );
    },
    receive: (message: unknown, identity: SessionMessageIdentity | null, persisted = false) => {
      const runId = identity?.idempotencyKey?.replace(/:user$/u, "");
      if (handoff && isInitialSubmissionReceipt(handoff, identity)) {
        if (runId) {
          retire(runId);
        }
        retireInitialChatSubmission(handoff);
        return message;
      }
      if (identity?.role !== "user" || !runId) {
        return message;
      }
      const receipt = persisted || identity.id !== null || identity.sequence !== null;
      if (receipt) {
        retire(runId);
      }
      const delivered = deliveredInScope(runId);
      if (!receipt && !identity.isImported && delivered && !delivered.pending) {
        return undefined;
      }
      if (!handoff || identity.isImported || runId !== handoff.pendingRunId) {
        return message;
      }
      // Cached bytes for this retained submission are not a receipt. Omit
      // that snapshot copy; the pane admits the recorded local owner through
      // sendPending, preserving provenance even with sender/reply metadata.
      if (!receipt) {
        return undefined;
      }
      retireInitialChatSubmission(handoff);
      return message;
    },
  };
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
    publishChatSessionProjection(owner, projection);
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
    publishChatSessionProjection(owner, scopedProjection);
  }
  return scopedProjection;
}

export function getChatRunProjection(owner: object, runId: string) {
  return chatSessionProjections.get(owner)?.projection?.runs[runId];
}

/** Compare semantic custody without initializing a projection or retaining its body. */
export function ownsChatSessionProjectionScope(
  owner: object,
  scope: SessionProjectionScope,
): boolean {
  const current = chatSessionProjections.get(owner)?.projection;
  return Boolean(
    current && CHAT_PROJECTION_SCOPE_KEYS.every((key) => current.scope[key] === scope[key]),
  );
}

/** Read existing custody without initializing or publishing during tentative admission. */
export function readChatLocalOutputEntries(owner: object): readonly SessionProjectionEntry[] {
  return chatLocalOutputEntries(chatSessionProjections.get(owner)?.projection?.entries);
}

export function readChatLocalOutputs(owner: object): readonly unknown[] {
  return readChatLocalOutputEntries(owner).map((entry) => entry.message);
}

/** Tentative capacity reads never initialize or publish a projection. */
export function readChatHistoryRequestBudget(
  owner: ChatSessionProjectionOwner,
  prepared: { messages: readonly unknown[]; requiredSources: ReadonlySet<string> },
) {
  const projection = chatSessionProjections.get(owner)?.projection;
  const scope = readChatSessionProjectionScope(owner);
  return projection &&
    CHAT_PROJECTION_SCOPE_KEYS.every((key) => projection.scope[key] === scope[key])
    ? prepareChatHistoryRequestBudget(
        projection,
        prepared.messages,
        prepared.requiredSources,
        owner.lastLocalTerminalReconcile?.runId,
      )
    : undefined;
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

/** The only mutation boundary for the reducer and its rendered message array. */
export function publishChatSessionProjection(
  owner: ChatSessionProjectionOwner,
  incomingProjection: SessionProjectionState,
  options: {
    retainPairingQr?: boolean;
    acceptedRunIds?: ReadonlySet<string>;
    awaitTranscriptReceipt?: boolean;
  } = {},
): void {
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
  const current = chatSessionProjections.get(owner);
  const previous = current?.projection;
  if (
    options.retainPairingQr !== false &&
    previous &&
    previous.messages !== projection.messages &&
    !chatProjectionScopeChanged(previous.scope, projection.scope, [
      "sessionKey",
      "sessionId",
      "agentId",
      "lifecycleRevision",
    ])
  ) {
    // A leaf advance can still contain the same reply; never retain media across sessions.
    const entries = retainPairingQrEntries(previous.entries, projection.entries);
    if (entries !== projection.entries) {
      const enrichedSources = new Set<string>();
      const messages = entries.map((entry, index) => {
        if (entry.message !== projection.entries[index]?.message) {
          const source = nativeHistoryMessageSourceIdentity(entry.message);
          if (source) {
            enrichedSources.add(source);
          }
        }
        return entry.message;
      });
      if (owner.chatHistoryPagination) {
        owner.chatHistoryPagination = invalidateChatHistoryPacketSources(
          owner.chatHistoryPagination,
          enrichedSources,
        );
      }
      projection = { ...projection, entries, messages };
    }
  }
  const readerSource =
    previous && !chatProjectionScopeChanged(previous.scope, projection.scope)
      ? owner.readTranscriptAnchorSource?.()
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
  });
  reconcileChatReasoning(owner, projection, current?.projection?.messages);
  // Run-only transitions share the transcript array. Preserve their ownership
  // updates above without traversing or republishing every displayed row.
  if (current?.projection?.messages === projection.messages) {
    return;
  }
  publishResidentChatMessages(owner, previous, projection);
}

/** A retired connection cannot lend pairing credentials to its replacement's history. */
export function retireChatPairingQr(owner: ChatSessionProjectionOwner): void {
  const projection = getChatSessionProjection(owner);
  const retireEntry = (entry: SessionProjectionEntry): SessionProjectionEntry => {
    const message = removePairingQrContent(entry.message);
    return message === entry.message ? entry : { ...entry, message };
  };
  const entries = projection.entries.map(retireEntry);
  const runs = Object.fromEntries(
    Object.entries(projection.runs).map(([runId, run]) => {
      const message = removePairingQrContent(run.message);
      const terminal = run.inferredSnapshotTerminal;
      const entry = terminal ? retireEntry(terminal.entry) : undefined;
      return [
        runId,
        message === run.message && entry === terminal?.entry
          ? run
          : {
              ...run,
              message,
              ...(terminal && entry ? { inferredSnapshotTerminal: { ...terminal, entry } } : {}),
            },
      ];
    }),
  );
  publishChatSessionProjection(
    owner,
    { ...projection, entries, messages: entries.map((entry) => entry.message), runs },
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
  const occurrences = new Map<unknown, SessionProjectionEntry[]>();
  for (const entry of current.entries.toReversed()) {
    const queue = occurrences.get(entry.message);
    if (queue) {
      queue.push(entry);
    } else {
      occurrences.set(entry.message, [entry]);
    }
  }
  const entries = createSessionProjection(scope, acceptedMessages).entries.map(
    (entry) => occurrences.get(entry.message)?.pop() ?? entry,
  );
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
  retireChatSubmissionDisplay(owner, acceptedRunIds, { awaitTranscriptReceipt: true });
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
  options: { awaitTranscriptReceipt?: boolean } = {},
): void {
  if (!acceptedRunIds.size) {
    return;
  }
  const scope = readChatSessionProjectionScope(owner, {
    agentId: resolveUiSelectedSessionAgentId(owner),
  });
  const projection = getChatSessionProjection(owner, scope);
  const retired = acceptChatSubmissionProjection(
    owner,
    projection,
    acceptedRunIds,
    options.awaitTranscriptReceipt,
  );
  if (retired !== projection) {
    publishChatSessionProjection(owner, retired);
  }
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
    /** Caller proved append continuity using the same read that supplies the new snapshot. */
    localOutputScope?: SessionProjectionScope;
  } = {},
): SessionProjectionState {
  const scope = options.scope ?? readChatSessionProjectionScope(owner);
  const previous = chatSessionProjections.get(owner)?.projection;
  let current = getChatSessionProjection(owner, scope);
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
  projection = reduceSessionProjection(projection, { ...preparedEvent, scope });
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
  publishChatSessionProjection(owner, projection);
  return projection;
}
