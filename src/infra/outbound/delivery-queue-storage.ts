// Delivery queue storage persists replayable outbound send intents and tracks
// platform-send recovery state in the shared SQLite queue.
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RenderedMessageBatchPlanItem } from "../../channels/message/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { PluginHookReplyPayloadSendingContext } from "../../plugins/hook-types.js";
import {
  completeDeliveryQueueEntry,
  commitStagedDeliveryQueueEntry,
  commitStagedDeliveryQueueEntryOnce,
  deleteDeliveryQueueEntry,
  failPendingDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
  insertDeliveryQueueEntryOnce,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  reserveDeliveryQueueEntryAttempt,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueRowMetadata,
  type DeliveryQueueCompletionRetention,
} from "../delivery-queue-sqlite.js";
import { generateSecureUuid } from "../secure-random.js";
import type {
  OutboundDeliveryFailureStage,
  OutboundPayloadDeliverySuppressionReason,
} from "./deliver-types.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_READ_NAMES,
} from "./delivery-queue-media-staging.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { IndexedMessageSentHookEvent } from "./message-sent-hook.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

export type QueuedRenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

export type QueuedReplyPayloadSendingHook = {
  kind: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  context: PluginHookReplyPayloadSendingContext;
};

export type QueuedPreDeliveryPayloadOutcome =
  | {
      index: number;
      status: "suppressed";
      reason: Exclude<OutboundPayloadDeliverySuppressionReason, "adapter_returned_no_identity">;
    }
  | {
      index: number;
      status: "failed";
      error: string;
      sentBeforeError: false;
      stage: OutboundDeliveryFailureStage;
    };

export type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /** Original queue durability policy when known. */
  queuePolicy?: "required" | "best_effort";
  /** Caller preflight explicitly required provider unknown-send reconciliation. */
  requireUnknownSendReconciliation?: boolean;
  /** Adapter replay protocol captured before this durable intent was written. */
  durableDeliveryProtocol?: string;
  /** Payloads accepted for durable replay; v2 rows contain only post-policy content. */
  payloads: ReplyPayload[];
  /** Payload indexes whose modifying hooks completed before the durable intent was written. */
  preparedHookPayloadIndexes?: number[];
  /** Maps compacted queued payload positions to stable original batch indexes. */
  payloadSourceIndexes?: number[];
  /** Queue-safe terminals for source payloads removed before native delivery. */
  preDeliveryPayloadOutcomes?: QueuedPreDeliveryPayloadOutcome[];
  /** Original logical batch cardinality before pre-delivery compaction. */
  sourcePayloadCount?: number;
  /** New rows defer message_sent until the durable queue reaches one logical terminal. */
  messageSentHookMode?: "logical_terminal";
  /** Queue-local payload indexes that reached the observer-visible provider boundary. */
  messageSentProviderAttemptedPayloadIndexes?: number[];
  /** Provider-finalized successes retained until the durable intent reaches one terminal. */
  messageSentHookEvents?: IndexedMessageSentHookEvent[];
  /** Replayable projection summary captured when the durable send intent is created. */
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  /** Replayable reply payload hook context for recovery and live delivery. */
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
  silent?: boolean;
  mirror?: OutboundMirror;
  /** Session context needed to preserve outbound media policy on recovery. */
  session?: OutboundSessionContext;
  /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
  gatewayClientScopes?: readonly string[];
  /** Channel-valid id reserved before enqueue; recovery must reuse it atomically. */
  preparedMessageId?: string;
  /** Serializable owner state finalized by both live delivery and recovery. */
  deliveryCompletion?: DurableDeliveryCompletion;
  /** Retain a terminal receipt when the producer may replay this stable intent indefinitely. */
  completionRetention?: DeliveryQueueCompletionRetention;
  /** Producer-specific retry budget; omitted entries use the queue default. */
  maxRetries?: number;
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  attemptCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendStartedAt?: number;
  /** Canonical reply target after hooks; null records an intentional root send. */
  effectiveReplyToId?: string | null;
  recoveryState?: "send_attempt_started" | "unknown_after_send";
}

type OutboundDeliveryQueueStatus = "pending" | "terminal" | "absent";

function queuedDeliveryMetadata(entry: QueuedDelivery): DeliveryQueueRowMetadata {
  return {
    entryKind: "outbound",
    sessionKey: entry.session?.key,
    channel: entry.channel,
    target: entry.to,
    accountId: entry.accountId,
  };
}

function createQueuedDelivery(params: QueuedDeliveryPayload, id: string): QueuedDelivery {
  return {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    queuePolicy: params.queuePolicy,
    requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
    durableDeliveryProtocol: params.durableDeliveryProtocol,
    payloads: params.payloads,
    preparedHookPayloadIndexes: params.preparedHookPayloadIndexes,
    payloadSourceIndexes: params.payloadSourceIndexes,
    preDeliveryPayloadOutcomes: params.preDeliveryPayloadOutcomes,
    sourcePayloadCount: params.sourcePayloadCount,
    messageSentHookMode: params.messageSentHookMode,
    messageSentProviderAttemptedPayloadIndexes: params.messageSentProviderAttemptedPayloadIndexes,
    messageSentHookEvents: params.messageSentHookEvents,
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    replyPayloadSendingHook: params.replyPayloadSendingHook,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    gatewayClientScopes: params.gatewayClientScopes,
    preparedMessageId: params.preparedMessageId,
    deliveryCompletion: params.deliveryCompletion,
    completionRetention: params.completionRetention,
    maxRetries: params.maxRetries,
    retryCount: 0,
    attemptCount: 0,
  };
}

/** Persist a delivery entry before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryPayload,
  stateDir?: string,
  mediaStageId?: string,
): Promise<string> {
  const id = generateSecureUuid();
  const entry = createQueuedDelivery(params, id);
  const metadata = queuedDeliveryMetadata(entry);
  if (mediaStageId) {
    const committed = commitStagedDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      metadata,
      stagingId: mediaStageId,
      stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
      stateDir,
    });
    if (!committed) {
      throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
    }
  } else {
    upsertDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      metadata,
      stateDir,
    });
  }
  return id;
}

/** Inserts one stable queue id without replacing prior pending or completed ownership. */
export async function enqueueDeliveryOnce(
  params: QueuedDeliveryPayload,
  id: string,
  stateDir?: string,
  mediaStageId?: string,
): Promise<{ id: string; created: boolean }> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Stable delivery queue id is required");
  }
  const entry = createQueuedDelivery(params, normalizedId);
  const metadata = queuedDeliveryMetadata(entry);
  // Producer-stable ids span the shipped and current queue namespaces. Both
  // staged and direct commits must claim that logical identity atomically.
  const created = mediaStageId
    ? (() => {
        const result = commitStagedDeliveryQueueEntryOnce({
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          conflictingQueueNames: OUTBOUND_DELIVERY_QUEUE_READ_NAMES,
          entry,
          metadata,
          stagingId: mediaStageId,
          stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
          stateDir,
        });
        if (result === "missing") {
          throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
        }
        return result === "created";
      })()
    : insertDeliveryQueueEntryOnce({
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        conflictingQueueNames: OUTBOUND_DELIVERY_QUEUE_READ_NAMES,
        entry,
        metadata,
        stateDir,
      });
  return { id: normalizedId, created };
}

function loadEntrySpoolPathsInQueue(
  queueName: string,
  id: string,
  stateDir: string | undefined,
): string[] {
  const entry = loadDeliveryQueueEntry(queueName, id, stateDir) as QueuedDelivery | null;
  return entry ? collectEntrySpoolPaths(entry.payloads, stateDir) : [];
}

/** Spool artifacts any pending representation of this logical row still references. */
function loadEntrySpoolPaths(id: string, stateDir: string | undefined): string[] {
  return [
    ...new Set(
      OUTBOUND_DELIVERY_QUEUE_READ_NAMES.flatMap((queueName) =>
        loadEntrySpoolPathsInQueue(queueName, id, stateDir),
      ),
    ),
  ];
}

type AckDeliveryOptions = {
  /** Caller holds a GC-visible recovery lease until its active adapter settles. */
  retainSpoolArtifacts?: boolean;
};

/** Remove a successfully delivered entry, or retain its permanent producer receipt. */
export async function ackDelivery(
  id: string,
  stateDir?: string,
  options?: AckDeliveryOptions,
): Promise<void> {
  // Read the media references before the row goes, then unlink only after the
  // delete commits. A crash in between leaves an orphan for the retention sweep;
  // unlinking first could strip media from a row that still has to replay.
  const spoolPaths = loadEntrySpoolPaths(id, stateDir);
  for (const queueName of OUTBOUND_DELIVERY_QUEUE_READ_NAMES) {
    const entry = loadDeliveryQueueEntry(queueName, id, stateDir) as QueuedDelivery | null;
    if (entry?.completionRetention === "permanent") {
      completeDeliveryQueueEntry(queueName, id, stateDir);
    } else {
      deleteDeliveryQueueEntry(queueName, id, stateDir);
    }
  }
  if (!options?.retainSpoolArtifacts) {
    await releaseSpoolArtifacts(spoolPaths, stateDir);
  }
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
  }));
}

/** Record a failed attempt whose retry provably cannot duplicate a recipient-visible send. */
export async function failDeliveryBeforePlatformSend(
  id: string,
  error: string,
  stateDir?: string,
  payloadIndexes?: readonly number[],
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => {
    const clearedPayloadIndexes = payloadIndexes ? new Set(payloadIndexes) : undefined;
    const retainedProviderAttempts = clearedPayloadIndexes
      ? entry.messageSentProviderAttemptedPayloadIndexes?.filter(
          (payloadIndex) => !clearedPayloadIndexes.has(payloadIndex),
        )
      : undefined;
    const hasRetainedSendEvidence =
      clearedPayloadIndexes !== undefined &&
      ((retainedProviderAttempts?.length ?? 0) > 0 ||
        entry.messageSentHookEvents?.some((event) => event.event.success) === true);
    return {
      ...entry,
      retryCount: entry.retryCount + 1,
      lastAttemptAt: Date.now(),
      lastError: error,
      // Intent-wide ambiguity cannot be cleared while any payload retains send
      // evidence; recovery would otherwise replay that logical batch blindly.
      platformSendStartedAt: hasRetainedSendEvidence ? entry.platformSendStartedAt : undefined,
      recoveryState: hasRetainedSendEvidence ? entry.recoveryState : undefined,
      messageSentProviderAttemptedPayloadIndexes:
        retainedProviderAttempts && retainedProviderAttempts.length > 0
          ? retainedProviderAttempts
          : undefined,
    };
  });
}

function appendMessageSentProviderAttemptedPayloadIndex(
  entry: QueuedDelivery,
  payloadIndex: number | undefined,
): number[] | undefined {
  if (payloadIndex === undefined) {
    return entry.messageSentProviderAttemptedPayloadIndexes;
  }
  return [...new Set([...(entry.messageSentProviderAttemptedPayloadIndexes ?? []), payloadIndex])];
}

/** Adds per-payload observer evidence without changing intent-wide recovery state. */
export async function markDeliveryMessageSentProviderAttempted(
  id: string,
  payloadIndex: number,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    messageSentProviderAttemptedPayloadIndexes: appendMessageSentProviderAttemptedPayloadIndex(
      entry,
      payloadIndex,
    ),
  }));
}

/** Remove observer evidence for payloads the provider proved were never dispatched. */
export async function clearDeliveryMessageSentProviderAttempts(
  id: string,
  payloadIndexes: readonly number[],
  stateDir?: string,
): Promise<void> {
  if (payloadIndexes.length === 0) {
    return;
  }
  const cleared = new Set(payloadIndexes);
  updateQueuedDelivery(id, stateDir, (entry) => {
    const retained = entry.messageSentProviderAttemptedPayloadIndexes?.filter(
      (payloadIndex) => !cleared.has(payloadIndex),
    );
    return {
      ...entry,
      messageSentProviderAttemptedPayloadIndexes:
        retained && retained.length > 0 ? retained : undefined,
    };
  });
}

/** Persist one provider-finalized success before another payload or queue transition can fail. */
export async function recordDeliveryMessageSentHookEvent(
  id: string,
  event: IndexedMessageSentHookEvent,
  stateDir?: string,
): Promise<void> {
  if (!event.event.success) {
    return;
  }
  updateQueuedDelivery(id, stateDir, (entry) => {
    const byPayload = new Map(
      entry.messageSentHookEvents?.map((existing) => [existing.payloadIndex, existing]) ?? [],
    );
    byPayload.set(event.payloadIndex, structuredClone(event));
    return {
      ...entry,
      messageSentHookEvents: [...byPayload.values()].toSorted(
        (left, right) => left.payloadIndex - right.payloadIndex,
      ),
    };
  });
}

/** Record a failed attempt without losing evidence that platform delivery may have completed. */
export async function failDeliveryAfterPlatformSend(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    recoveryState: "unknown_after_send",
  }));
}

/** Reserve one durable delivery call before invoking the provider path. */
export async function reserveDeliveryAttempt(id: string, maxAttempts: number, stateDir?: string) {
  return reserveDeliveryQueueEntryAttempt({
    queueName: resolveDeliveryQueueName(id, stateDir),
    id,
    maxAttempts,
    stateDir,
  });
}

function updateQueuedDelivery(
  id: string,
  stateDir: string | undefined,
  update: (entry: QueuedDelivery) => QueuedDelivery,
): void {
  const queueName = resolveDeliveryQueueName(id, stateDir);
  updateDeliveryQueueEntry(queueName, id, stateDir, (entry) => update(entry as QueuedDelivery));
}

function resolveDeliveryQueueName(id: string, stateDir?: string): string {
  return (
    OUTBOUND_DELIVERY_QUEUE_READ_NAMES.find((queueName) =>
      loadDeliveryQueueEntry(queueName, id, stateDir),
    ) ?? OUTBOUND_DELIVERY_QUEUE_NAME
  );
}

export async function markDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null; payloadIndex?: number },
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
    messageSentProviderAttemptedPayloadIndexes: appendMessageSentProviderAttemptedPayloadIndex(
      entry,
      route?.payloadIndex,
    ),
  }));
}

/** Refresh the attempt timestamp before recipient-visible or finalizing platform I/O. */
export async function markDeliveryPlatformSendDispatched(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null; payloadIndex?: number },
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
    messageSentProviderAttemptedPayloadIndexes: appendMessageSentProviderAttemptedPayloadIndex(
      entry,
      route?.payloadIndex,
    ),
  }));
}

export async function markDeliveryPlatformOutcomeUnknown(
  id: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    recoveryState: "unknown_after_send",
  }));
}

/** Load a single pending delivery entry by ID from the queue directory. */
export async function loadPendingDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  for (const queueName of OUTBOUND_DELIVERY_QUEUE_READ_NAMES) {
    const entry = loadDeliveryQueueEntry(queueName, id, stateDir) as QueuedDelivery | null;
    if (entry) {
      return entry;
    }
  }
  return null;
}

/** Read lifecycle state without exposing queue storage details to delivery adapters. */
export function getOutboundDeliveryQueueStatus(
  id: string,
  stateDir?: string,
): OutboundDeliveryQueueStatus {
  let terminal = false;
  for (const queueName of OUTBOUND_DELIVERY_QUEUE_READ_NAMES) {
    const status = getDeliveryQueueEntryStatus(queueName, id, stateDir);
    if (status === "pending") {
      return "pending";
    }
    terminal ||= status === "failed" || status === "completed";
  }
  return terminal ? "terminal" : "absent";
}

/** Load all pending delivery entries from the queue. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const entriesById = new Map<string, QueuedDelivery>();
  for (const queueName of OUTBOUND_DELIVERY_QUEUE_READ_NAMES) {
    for (const entry of loadDeliveryQueueEntries(queueName, stateDir) as QueuedDelivery[]) {
      if (!entriesById.has(entry.id)) {
        entriesById.set(entry.id, entry);
      }
    }
  }
  return [...entriesById.values()].toSorted(
    (a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id),
  );
}

/** Move a queue entry out of the pending retry set. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  // Dead-lettered rows are retained but never replayed: recovery loads the
  // pending set only, so a failed row's media has no remaining reader.
  const queueName = resolveDeliveryQueueName(id, stateDir);
  const spoolPaths = loadEntrySpoolPathsInQueue(queueName, id, stateDir);
  moveDeliveryQueueEntryToFailed(queueName, id, stateDir);
  await releaseSpoolArtifacts(spoolPaths, stateDir);
}

type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: {
    id: string;
    expectedStatus: "pending";
    lastError: string;
    entry: QueuedDelivery;
  },
  stateDir?: string,
): Promise<FailPendingDeliveryResult> {
  const result = failPendingDeliveryQueueEntry({
    queueName: resolveDeliveryQueueName(params.id, stateDir),
    ...params,
    stateDir,
  });
  // Only the writer that won the guarded transition owns the media; a
  // not_pending result means another path holds the row and its artifacts.
  if (result.status === "failed") {
    await releaseSpoolArtifacts(collectEntrySpoolPaths(params.entry.payloads, stateDir), stateDir);
  }
  return result;
}
