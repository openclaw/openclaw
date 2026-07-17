// Delivery queue storage persists replayable outbound send intents and tracks
// platform-send recovery state in the shared SQLite queue.
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RenderedMessageBatchPlanItem } from "../../channels/message/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { PluginHookReplyPayloadSendingContext } from "../../plugins/hook-types.js";
import {
  compareAndSwapPendingDeliveryQueueEntries,
  compareAndSwapPendingDeliveryQueueEntry,
  completeDeliveryQueueEntry,
  commitStagedDeliveryQueueEntry,
  commitStagedDeliveryQueueEntryOnce,
  deleteDeliveryQueueEntry,
  failPendingDeliveryQueueEntry,
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
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import {
  parseQueuedOutboundEffectAuthorization,
  type OutboundEffectAuthorizationSealHandle,
  type OutboundEffectAuthorizationScope,
  type QueuedOutboundEffectAuthorization,
} from "./effect-authorization.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
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

export type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /** Original queue durability policy when known. */
  queuePolicy?: "required" | "best_effort";
  /** Caller preflight explicitly required provider unknown-send reconciliation. */
  requireUnknownSendReconciliation?: boolean;
  /** Final-effect policy or broadcast-ordering seal. Absent on ordinary deliveries. */
  effectAuthorization?: QueuedOutboundEffectAuthorization;
  /** Whether this queued intent originated at the message-action authorization boundary. */
  effectAuthorizationScope?: OutboundEffectAuthorizationScope;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
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
    effectAuthorization: params.effectAuthorization,
    effectAuthorizationScope: params.effectAuthorizationScope,
    payloads: params.payloads,
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
  const created = mediaStageId
    ? (() => {
        const result = commitStagedDeliveryQueueEntryOnce({
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
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
    : upsertDeliveryQueueEntry({
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        entry,
        metadata,
        stateDir,
        insertOnly: true,
      });
  return { id: normalizedId, created };
}

/** Spool artifacts a pending row still references; empty once it is gone or unreadable. */
function loadEntrySpoolPaths(id: string, stateDir: string | undefined): string[] {
  const entry = loadDeliveryQueueEntry(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
  ) as QueuedDelivery | null;
  return entry ? collectEntrySpoolPaths(entry.payloads, stateDir) : [];
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
  const entry = loadDeliveryQueueEntry(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
  ) as QueuedDelivery | null;
  const spoolPaths = entry ? collectEntrySpoolPaths(entry.payloads, stateDir) : [];
  if (entry?.completionRetention === "permanent") {
    completeDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
  } else {
    deleteDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
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
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
    // Clear both fields together; retaining either would preserve false send evidence.
    platformSendStartedAt: undefined,
    recoveryState: undefined,
  }));
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
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
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
  updateDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir, (entry) =>
    update(entry as QueuedDelivery),
  );
}

export async function markDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
  }));
}

/** Refresh the attempt timestamp before recipient-visible or finalizing platform I/O. */
export async function markDeliveryPlatformSendDispatched(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
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

/** Seal the exact final semantic payload while the row still has its pending digest. */
export async function sealDeliveryEffectAuthorization(params: {
  id: string;
  expectedDigest: string;
  finalDigest: string;
  stateDir?: string;
}): Promise<OutboundEffectAuthorizationSealHandle> {
  const result = compareAndSwapPendingDeliveryQueueEntry({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id: params.id,
    stateDir: params.stateDir,
    compare: (entry) => {
      const authorization = parseQueuedOutboundEffectAuthorization(
        (entry as QueuedDelivery).effectAuthorization,
      );
      return authorization?.state === "pending" && authorization.digest === params.expectedDigest;
    },
    update: (entry) => {
      const queued = entry as QueuedDelivery;
      const authorization = parseQueuedOutboundEffectAuthorization(queued.effectAuthorization);
      if (!authorization || authorization.state !== "pending") {
        return queued;
      }
      return {
        ...queued,
        effectAuthorization: {
          ...authorization,
          state: "sealed",
          digest: params.finalDigest,
        },
      };
    },
  });
  if (result.status !== "updated") {
    throw new Error(`Delivery effect authorization seal ${result.status} for ${params.id}`);
  }
  return {
    kind: "outbound-effect-authorization",
    version: 1,
    id: params.id,
    digest: params.finalDigest,
  };
}

function isValidEffectAuthorizationSealHandle(
  handle: OutboundEffectAuthorizationSealHandle,
): boolean {
  return (
    handle.kind === "outbound-effect-authorization" &&
    handle.version === 1 &&
    Boolean(handle.id.trim()) &&
    parseQueuedOutboundEffectAuthorization({
      version: 1,
      state: "sealed",
      digest: handle.digest,
      mediaAliases: [],
    }) !== null
  );
}

/** Promote every sealed delivery in one transaction; one mismatch promotes none. */
export function authorizeSealedDeliveryEffects(
  handles: readonly OutboundEffectAuthorizationSealHandle[],
  stateDir?: string,
): void {
  if (handles.length === 0) {
    return;
  }
  if (handles.some((handle) => !isValidEffectAuthorizationSealHandle(handle))) {
    throw new Error("Malformed outbound effect authorization seal handle");
  }
  const result = compareAndSwapPendingDeliveryQueueEntries({
    stateDir,
    entries: handles.map((handle) => ({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: handle.id,
      compare: (entry) => {
        const authorization = parseQueuedOutboundEffectAuthorization(
          (entry as QueuedDelivery).effectAuthorization,
        );
        return authorization?.state === "sealed" && authorization.digest === handle.digest;
      },
      update: (entry) => {
        const queued = entry as QueuedDelivery;
        const authorization = parseQueuedOutboundEffectAuthorization(queued.effectAuthorization);
        if (!authorization || authorization.state !== "sealed") {
          return queued;
        }
        return {
          ...queued,
          effectAuthorization: { ...authorization, state: "authorized" },
        };
      },
    })),
  });
  if (result.status !== "updated") {
    throw new Error(
      `Delivery effect authorization batch ${result.status} for ${"id" in result ? result.id : "unknown"}`,
    );
  }
}

/** Refuse transport if a barrier returned without atomically promoting this seal. */
export async function assertDeliveryEffectAuthorized(
  handle: OutboundEffectAuthorizationSealHandle,
  stateDir?: string,
): Promise<void> {
  const entry = await loadPendingDelivery(handle.id, stateDir);
  const authorization = parseQueuedOutboundEffectAuthorization(entry?.effectAuthorization);
  if (authorization?.state !== "authorized" || authorization.digest !== handle.digest) {
    throw new Error(`Delivery effect authorization was not promoted for ${handle.id}`);
  }
}

/** Load a single pending delivery entry by ID from the queue directory. */
export async function loadPendingDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  return loadDeliveryQueueEntry(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
  ) as QueuedDelivery | null;
}

/** Load all pending delivery entries from the queue. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  return loadDeliveryQueueEntries(OUTBOUND_DELIVERY_QUEUE_NAME, stateDir) as QueuedDelivery[];
}

/** Move a queue entry out of the pending retry set. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  // Dead-lettered rows are retained but never replayed: recovery loads the
  // pending set only, so a failed row's media has no remaining reader.
  const spoolPaths = loadEntrySpoolPaths(id, stateDir);
  moveDeliveryQueueEntryToFailed(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
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
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
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
