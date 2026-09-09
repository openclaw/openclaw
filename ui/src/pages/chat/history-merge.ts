import {
  createSessionProjection,
  readSessionMessageIdentity,
  reduceSessionProjection,
  retainSessionProjectionRuns,
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
import type {
  ApplicationChatSubmissions,
  RetainedChatSubmission,
} from "../../app/chat-submissions.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { chatOutboxDeliveryKey, type ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import {
  resolveUiSelectedSessionAgentId,
  resolveUiConversationIdentity,
} from "../../lib/sessions/session-key.ts";
import { matchesCompactionOperation } from "./chat-progress.ts";
import type { CompactionStatus } from "./tool-stream-contract.ts";

type ChatRunProvenance = { scope: object; status: string };
type ChatProjectionOwner = {
  projection?: SessionProjectionState;
  runId?: string;
  scope: object;
  lifetime: object;
  runs: Readonly<Record<string, ChatRunProvenance>>;
};

const chatSessionProjections = new WeakMap<object, ChatProjectionOwner>();

function readChatProjectionOwner(owner: object): ChatProjectionOwner {
  let current = chatSessionProjections.get(owner);
  if (!current) {
    current = { scope: {}, lifetime: {}, runs: {} };
    chatSessionProjections.set(owner, current);
  }
  return current;
}

export function captureChatProjectionScope(owner: object, runId?: string): () => boolean {
  const captured = readChatProjectionOwner(owner);
  const sessionId = captured.projection?.scope.sessionId;
  const ownedRunId =
    runId &&
    captured.runId === runId &&
    Object.hasOwn(captured.runs, runId) &&
    captured.runs[runId].scope === captured.scope
      ? runId
      : undefined;
  return () => {
    const current = readChatProjectionOwner(owner);
    return (
      current.scope === captured.scope ||
      Boolean(
        ownedRunId &&
        sessionId &&
        current.projection?.scope.sessionId === sessionId &&
        current.lifetime === captured.lifetime &&
        current.runId === ownedRunId &&
        Object.hasOwn(current.runs, ownedRunId) &&
        current.runs[ownedRunId].scope === current.scope,
      )
    );
  };
}

export function chatRunBelongsToRetiredScope(owner: object, runId: string): boolean {
  const current = readChatProjectionOwner(owner);
  const run = Object.hasOwn(current.runs, runId) ? current.runs[runId] : undefined;
  return run !== undefined && run.scope !== current.scope;
}
// Display ownership outlives active-state cleanup. It is not the foreground
// terminal fence: an unowned final cannot suppress authoritative active rows.
const CHAT_PROJECTION_SCOPE_KEYS = [
  "sessionKey",
  "sessionId",
  "agentId",
  "lifecycleRevision",
  "activeLeafEntryId",
] as const;

type ChatSessionProjectionOwner = ChatComposerScope & {
  sessionKey: string;
  chatMessages: unknown[];
  chatSubmissions?: ApplicationChatSubmissions;
  currentSessionId?: string | null;
  chatDisplayedLeafEntryId?: string | null;
  compactionStatus?: CompactionStatus | null;
  compactionClearTimer?: number | null;
};

function resetCompactionProjection(owner: ChatSessionProjectionOwner): void {
  if (owner.compactionClearTimer != null) {
    clearTimeout(owner.compactionClearTimer);
    owner.compactionClearTimer = null;
  }
  owner.compactionStatus = null;
}

type ChatSessionProjectionScopeOptions = Omit<SessionProjectionScope, "sessionId"> & {
  sessionId?: string | null;
};

function readChatSubmissionBatch(owner: ChatSessionProjectionOwner, scope: SessionProjectionScope) {
  const submissions = owner.chatSubmissions;
  if (!submissions) {
    return undefined;
  }
  const sessionKey = scope.sessionKey ?? owner.sessionKey;
  const client = owner.client;
  const handoff = submissions.readInitial(sessionKey, client ?? null);
  // The pane captures one client and delivery key for the synchronous receipt batch.
  const key = chatOutboxDeliveryKey(owner, {
    sessionKey,
    agentId: scope.agentId ?? resolveUiSelectedSessionAgentId(owner),
  });
  const retire = (runId: string) => {
    const entry = submissions.readDelivered(key + runId, client ?? owner);
    if (
      entry?.kind === "delivered" &&
      (!entry.sessionId || !scope.sessionId || entry.sessionId === scope.sessionId)
    ) {
      entry.pending = false;
    }
  };
  return {
    initial: handoff,
    accept: (runIds: ReadonlySet<string>) => {
      runIds.forEach(retire);
      if (handoff && runIds.has(handoff.pendingRunId)) {
        handoff.pending = false;
      }
    },
    receive: (message: unknown, identity: SessionMessageIdentity | null, persisted = false) => {
      const runId = identity?.idempotencyKey?.replace(/:user$/u, "");
      if (identity?.role !== "user" || !runId) {
        return message;
      }
      const receipt = persisted || identity.id !== null || identity.sequence !== null;
      if (receipt) {
        retire(runId);
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
      handoff.pending = false;
      return message;
    },
  };
}

/** Every live, pending, terminal, and history path must identify the same pane and branch. */
export function readChatSessionProjectionScope(
  owner: ChatSessionProjectionOwner,
  options: ChatSessionProjectionScopeOptions = {},
): SessionProjectionScope {
  const sessionId = Object.hasOwn(options, "sessionId")
    ? options.sessionId
    : owner.currentSessionId;
  return {
    sessionKey: resolveUiConversationIdentity(owner, options.sessionKey ?? owner.sessionKey)
      .sessionKey,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(options.lifecycleRevision !== undefined
      ? { lifecycleRevision: options.lifecycleRevision }
      : {}),
    ...(Object.hasOwn(options, "activeLeafEntryId") ||
    Object.hasOwn(owner, "chatDisplayedLeafEntryId")
      ? {
          activeLeafEntryId: Object.hasOwn(options, "activeLeafEntryId")
            ? (options.activeLeafEntryId ?? null)
            : (owner.chatDisplayedLeafEntryId ?? null),
        }
      : {}),
  };
}

function chatProjectionScopeChanged(
  previous: SessionProjectionScope,
  scope: SessionProjectionScope,
) {
  return CHAT_PROJECTION_SCOPE_KEYS.some(
    (key) =>
      Object.hasOwn(scope, key) && previous[key] !== undefined && previous[key] !== scope[key],
  );
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
    const projection = createSessionProjection(scope, owner.chatMessages);
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

export function getChatRunOwner(owner: object): string | undefined {
  return chatSessionProjections.get(owner)?.runId;
}

export function setChatRunOwner(owner: object, runId: string | undefined): void {
  const current = readChatProjectionOwner(owner);
  chatSessionProjections.set(owner, {
    ...current,
    runId,
    runs: runId
      ? retainSessionProjectionRuns({
          ...current.runs,
          [runId]: {
            scope: current.scope,
            // A local ACK can bind display before its run projection arrives.
            status: current.projection?.runs[runId]?.status ?? "streaming",
          },
        })
      : current.runs,
  });
}

/** The only mutation boundary for the reducer and its rendered message array. */
export function publishChatSessionProjection(
  owner: ChatSessionProjectionOwner,
  projection: SessionProjectionState,
  options: { resetScope?: boolean } = {},
): void {
  const current = readChatProjectionOwner(owner);
  const runId = current.runId;
  const replacesScope = Boolean(
    options.resetScope ||
    (current.projection && chatProjectionScopeChanged(current.projection.scope, projection.scope)),
  );
  const scope = replacesScope ? {} : current.scope;
  // Leaf growth can continue the same live run. Reset, topology changes and
  // physical session replacement must never authorize an older pending callback.
  const previousScope = current.projection?.scope;
  const lifetime =
    options.resetScope ||
    (previousScope &&
      CHAT_PROJECTION_SCOPE_KEYS.some(
        (key) =>
          key !== "activeLeafEntryId" &&
          Object.hasOwn(projection.scope, key) &&
          previousScope[key] !== undefined &&
          previousScope[key] !== projection.scope[key],
      ))
      ? {}
      : current.lifetime;
  const runs = new Map<string, ChatRunProvenance>();
  if (replacesScope) {
    for (const entry of current.projection?.entries ?? []) {
      const id = entry.pendingRunId ?? entry.identity?.runId;
      if (id) {
        runs.set(id, { scope: current.scope, status: "completed" });
      }
    }
  }
  // Keep recent live provenance after historical rows in the shared retention budget.
  for (const [id, run] of Object.entries(current.runs)) {
    runs.delete(id);
    runs.set(id, replacesScope ? { scope: run.scope, status: "completed" } : run);
  }
  for (const [id, run] of Object.entries(projection.runs)) {
    const known = runs.get(id);
    if (!known || known.scope === scope) {
      runs.set(id, { scope, status: run.status });
    }
  }
  if (
    current.projection &&
    chatProjectionScopeChanged(current.projection.scope, projection.scope)
  ) {
    const status = owner.compactionStatus;
    const sessionKeys = ["sessionKey", "sessionId", "agentId"] as const;
    const previousSessionScope = current.projection.scope;
    const sessionChanged = sessionKeys.some(
      (key) =>
        Object.hasOwn(projection.scope, key) &&
        previousSessionScope[key] !== undefined &&
        previousSessionScope[key] !== projection.scope[key],
    );
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
  chatSessionProjections.set(owner, {
    projection,
    scope,
    lifetime,
    runs: retainSessionProjectionRuns(Object.fromEntries(runs)),
    runId: runId && Object.hasOwn(projection.runs, runId) && !replacesScope ? runId : undefined,
  });
  // Run-only transitions share the transcript array. Preserve their ownership
  // updates above without traversing or republishing every displayed row.
  if (current.projection?.messages === projection.messages) {
    return;
  }
  if (
    owner.chatMessages.length !== projection.messages.length ||
    owner.chatMessages.some((message, index) => message !== projection.messages[index])
  ) {
    owner.chatMessages = [...projection.messages];
  }
}

/** Publish one exact live transcript order without dropping reducer-owned entry identity. */
export function publishChatSessionProjectionMessages(
  owner: ChatSessionProjectionOwner,
  messages: readonly unknown[],
  options: {
    event?: SessionProjectionEvent;
    scope?: SessionProjectionScope;
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
  publishChatSessionProjection(owner, projection);
  return projection;
}

/** Custody is its own display collection; only canonical user IDs can replace it. */
export function selectChatInputDisplay(
  messages: readonly unknown[],
  queue: readonly ChatQueueItem[],
  inputs: ChatPendingInputsPage["items"],
) {
  const userIds = new Set<string>();
  const sendKeys = new Set<string>();
  for (const message of messages) {
    const identity = readSessionMessageIdentity(message);
    if (identity?.role === "user") {
      if (identity.id) {
        userIds.add(identity.id);
      }
      if (identity.idempotencyKey) {
        sendKeys.add(identity.idempotencyKey);
      }
    }
  }
  const accepted = new Set(inputs.map((input) => input.runId));
  return {
    queue: queue.filter(
      (item) =>
        !item.sendRunId ||
        (!accepted.has(item.sendRunId) &&
          !sendKeys.has(item.sendRunId) &&
          !sendKeys.has(`${item.sendRunId}:user`)),
    ),
    pendingInputs: inputs.filter((input) => !userIds.has(input.id)),
  };
}

/** A custody or consumption receipt retires only an uncommitted local user source. */
export function reconcileChatInputCustody(
  owner: ChatSessionProjectionOwner,
  page: ChatPendingInputsPage | undefined,
  receipts: ChatInputReceipts = [],
) {
  const scope = readChatSessionProjectionScope(owner, {
    agentId: resolveUiSelectedSessionAgentId(owner),
  });
  const acceptedRunIds = new Set(
    [...(page?.items ?? []), ...receipts]
      .map((item) => item.runId)
      .filter((runId) => typeof runId === "string"),
  );
  const submissions = readChatSubmissionBatch(owner, scope);
  submissions?.accept(acceptedRunIds);
  if (acceptedRunIds.size) {
    const projection = getChatSessionProjection(owner, scope);
    const entries = projection.entries.filter(
      (entry) =>
        !(
          entry.pending &&
          entry.identity?.role === "user" &&
          entry.identity.id === null &&
          entry.identity.sequence === null &&
          acceptedRunIds.has(entry.pendingRunId ?? "")
        ),
    );
    if (entries.length !== projection.entries.length) {
      publishChatSessionProjection(owner, {
        ...projection,
        entries,
        messages: entries.map((entry) => entry.message),
      });
    }
  }
  return {
    acceptedRunIds,
    page: page ?? { items: [], total: 0 },
  };
}

export function shouldDisplayChatSubmission(
  submission: RetainedChatSubmission,
  receipt: SessionMessageIdentity | null,
): boolean {
  // A local copy suppresses display; only a durable receipt retires ownership.
  if (receipt && (receipt.id !== null || receipt.sequence !== null)) {
    submission.pending = false;
  }
  return submission.pending && !receipt;
}

/** A retained submission has display ownership only until its own user receipt or custody. */
export function admitChatSubmission(
  owner: ChatSessionProjectionOwner,
  submission = owner.chatSubmissions?.readInitial(owner.sessionKey, owner.client ?? null),
): boolean {
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
  } = {},
): SessionProjectionState {
  const scope = options.scope ?? readChatSessionProjectionScope(owner);
  const current = getChatSessionProjection(owner, scope);
  const sessionKey = scope.sessionKey ?? owner.sessionKey;
  const submissions = readChatSubmissionBatch(owner, scope);
  const handoff = submissions?.initial;
  const initialPending = handoff?.pending;
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
  let projection = current;
  if (event.type === "snapshotLoaded" && handoff?.pending && options.runActive !== false) {
    projection = reduceSessionProjection(projection, {
      type: "sendPending",
      runId: handoff.pendingRunId,
      message: handoff.message,
      scope,
    });
  }
  projection = reduceSessionProjection(projection, { ...preparedEvent, scope });
  if (event.type === "sessionReset" && projection !== current) {
    resetCompactionProjection(owner);
  }
  // Without a transcript anchor this is best-effort display chronology, assuming
  // comparable browser/Gateway clocks. Never assign a sequence or reorder canonical
  // rows; older or untimestamped history stays ahead until authoritative adoption.
  const initialIndex =
    initialPending && handoff
      ? projection.entries.findIndex(
          (entry) => entry.pending && entry.pendingRunId === handoff.pendingRunId,
        )
      : -1;
  const initial = projection.entries[initialIndex];
  if (handoff && initial && initialIndex > 0) {
    const outputIndex = projection.entries.findIndex((entry, index) => {
      const message = asNullableRecord(entry.message);
      return (
        index < initialIndex &&
        message?.role !== "user" &&
        typeof message?.timestamp === "number" &&
        message.timestamp >= handoff.message.timestamp
      );
    });
    if (outputIndex >= 0) {
      const entries = projection.entries.toSpliced(initialIndex, 1);
      entries.splice(outputIndex, 0, initial);
      projection = { ...projection, entries, messages: entries.map((entry) => entry.message) };
    }
  }
  publishChatSessionProjection(owner, projection, {
    resetScope: event.type === "sessionReset" && projection !== current,
  });
  if (handoff && !handoff.pending && options.runActive === false) {
    owner.chatSubmissions?.clearInitial(sessionKey);
  }
  return projection;
}
