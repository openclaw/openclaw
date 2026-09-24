import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
// Delivery queue storage persists replayable outbound send intents and tracks
// platform-send recovery state in the shared SQLite queue.
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import type { InitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
  loadDeliveryQueueEntries,
} from "../delivery-queue-sqlite.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import type { DeliveryQueueWorkerOperations } from "../delivery-queue.worker-contract.js";
import { generateSecureUuid } from "../secure-random.js";
import { createSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../sqlite-worker-operation-settlement.js";
import { OutboundDeliveryError } from "./deliver-types.js";
import { failPendingDelivery } from "./delivery-queue-ack.js";
import { collectEntrySpoolPaths } from "./delivery-queue-media-spool.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import { StableDeliveryPreparationLostError } from "./delivery-queue-preparation.js";
import {
  decodeOutboundDeliverySnapshot,
  encodeOutboundDeliverySnapshot,
  projectOutboundDelivery,
} from "./delivery-queue-projection.js";
import type { StableDeliveryPreparation } from "./delivery-queue-storage.types.js";
import type {
  LegacyQueuedDelivery,
  LegacyQueuedDeliveryPreparation,
  DeliveryFailureSettlement,
  QueuedDelivery,
  QueuedDeliveryPayload,
} from "./delivery-queue-types.js";
import {
  acceptedPreparedOutboundEntries,
  createUnmodifiedPreparedOutboundBatch,
  projectPreparedOutboundBatchForStorage,
  type PreparedOutboundBatch,
} from "./prepared-batch.js";

export { ackDelivery } from "./delivery-queue-ack.js";

export type {
  LegacyQueuedDelivery,
  LegacyQueuedDeliveryPreparation,
  QueuedDelivery,
  QueuedReplyPayloadSendingHook,
  QueuedRenderedMessageBatchPlan,
} from "./delivery-queue-types.js";

const queuedDeliveryPayloads = (entry: QueuedDelivery) =>
  acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload);

export async function findDeliveryIntentOwner(
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
) {
  const [owner] = await findDeliveryIntentOwners([id], stateDir, context);
  return owner ?? null;
}

/** Resolve one ordered batch without reopening the store for each intent. */
export async function findDeliveryIntentOwners(
  ids: readonly string[],
  stateDir?: string,
  context?: DeliveryQueueStateContext,
) {
  if (ids.length === 0) {
    return [];
  }
  const captured = context ?? captureDeliveryQueueStateContext(stateDir);
  const owners = await executeDeliveryQueueOperation(captured, stateDir, {
    type: "deliveryQueue.findIntentOwners",
    input: { ids: [...ids] },
  });
  captured.workerContext.admission.assertCurrent();
  return owners;
}

function preparedBatchFromLowLevelInput(params: QueuedDeliveryPayload): PreparedOutboundBatch {
  if (params.preparedBatch) {
    return params.preparedBatch;
  }
  if (!params.payloads) {
    throw new Error("Delivery queue entry requires a prepared payload batch");
  }
  return createUnmodifiedPreparedOutboundBatch(params.payloads);
}

type QueuedDeliveryAdmissionPayload = QueuedDeliveryPayload & {
  initialProducerClaim?: InitialDeliveryProducerClaim;
};

function createQueuedDelivery(
  params: QueuedDeliveryAdmissionPayload,
  id: string,
  retainOnFailure: boolean,
): QueuedDelivery {
  return {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    queuePolicy: params.queuePolicy,
    requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
    ...(params.initialProducerClaim ??
      (params.requiresProducerClaim === true ? { requiresProducerClaim: true } : {})),
    preparedBatch: projectPreparedOutboundBatchForStorage(preparedBatchFromLowLevelInput(params)),
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    reply: params.reply,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    sessionGeneration: params.sessionGeneration,
    gatewayClientScopes: params.gatewayClientScopes,
    preparedMessageId: params.preparedMessageId,
    deliveryCompletion: params.deliveryCompletion,
    completionRetention: params.completionRetention,
    ...(retainOnFailure ? { retainOnFailure: true as const } : {}),
    legacyUnknownSendReconciliation: params.legacyUnknownSendReconciliation,
    legacyPreparedContentUnavailable: params.legacyPreparedContentUnavailable,
    maxRetries: params.maxRetries,
    retryCount: 0,
    attemptCount: 0,
  };
}

/** Keep uncertain publication with recovery even when the broker returns a cleanup error. */
async function enqueueQueuedDelivery(
  input: DeliveryQueueWorkerOperations["deliveryQueue.enqueue"]["input"],
  stateDir: string | undefined,
  context: DeliveryQueueStateContext | undefined,
) {
  let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
  let result: DeliveryQueueWorkerOperations["deliveryQueue.enqueue"]["output"];
  try {
    result = await executeDeliveryQueueOperation(
      context,
      stateDir,
      {
        type: "deliveryQueue.enqueue",
        input,
      },
      {
        createAdmission: (retained) => {
          settlement = retained.settled;
          return {
            nativeLocations: [],
            // This operation observes native settlement; it grants no additional authority.
            admission: createSqliteWorkerOperationAdmission(() => {
              throw new Error("Delivery enqueue does not request host transaction admission");
            }),
          };
        },
      },
    );
  } catch (cause) {
    if (settlement && (await settlement).kind !== "not-entered") {
      const error = new OutboundDeliveryError("Delivery queue publication could not be confirmed", {
        cause,
      });
      // Even a completed rejection may follow COMMIT and coordinator cleanup.
      error.queueCustody = "held";
      throw error;
    }
    throw cause;
  }
  if (typeof result !== "string") {
    const error = new Error("Delivery queue publication failed");
    retainOpenClawStateWorkerErrorPayload(error, result.error);
    // A full rollback result proves nonpublication; do not reclassify it as uncertain execution.
    throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
  }
  return result;
}

/** Persist a delivery entry before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryAdmissionPayload,
  stateDir?: string,
  mediaStageId?: string,
  context?: DeliveryQueueStateContext,
): Promise<string> {
  const captured = context ?? captureDeliveryQueueStateContext(stateDir);
  const id = generateSecureUuid();
  const entry = createQueuedDelivery(
    params,
    id,
    params.deliveryCompletion !== undefined || params.completionRetention !== undefined,
  );
  const result = await enqueueQueuedDelivery(
    { kind: "random", entryJson: JSON.stringify(entry), mediaStageId },
    stateDir,
    captured,
  );
  if (result === "missing") {
    throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
  }
  if (result === "existing") {
    throw new Error(`Delivery queue entry already exists: ${OUTBOUND_DELIVERY_QUEUE_NAME}/${id}`);
  }
  return id;
}

/** Inserts one stable queue id without replacing prior pending or completed ownership. */
export async function enqueueDeliveryOnce(
  params: QueuedDeliveryAdmissionPayload,
  id: string,
  stateDir?: string,
  mediaStageId?: string,
  context?: DeliveryQueueStateContext,
): Promise<{ id: string; created: boolean }> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Stable delivery queue id is required");
  }
  const captured = context ?? captureDeliveryQueueStateContext(stateDir);
  const entry = createQueuedDelivery(params, normalizedId, true);
  const result = await enqueueQueuedDelivery(
    { kind: "stable", entryJson: JSON.stringify(entry), mediaStageId },
    stateDir,
    captured,
  );
  if (result === "missing") {
    throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
  }
  return { id: normalizedId, created: result === "created" };
}

/** Atomically replaces a payload-free stable preparation owner with prepared custody. */
export async function enqueuePreparedDeliveryOnce(
  params: QueuedDeliveryAdmissionPayload,
  id: string,
  preparation: StableDeliveryPreparation,
  stateDir?: string,
  mediaStageId?: string,
  context?: DeliveryQueueStateContext,
): Promise<{ id: string; created: boolean }> {
  const normalizedId = id.trim();
  if (!normalizedId || normalizedId !== preparation.id) {
    throw new Error("Stable delivery preparation id is invalid");
  }
  const captured = context ?? captureDeliveryQueueStateContext(stateDir);
  const entry = createQueuedDelivery(params, normalizedId, true);
  const result = await enqueueQueuedDelivery(
    {
      kind: "prepared",
      entryJson: JSON.stringify(entry),
      preparationJson: JSON.stringify(preparation),
      mediaStageId,
    },
    stateDir,
    captured,
  );
  if (result === "staging-missing") {
    throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
  }
  if (result !== "moved") {
    throw new StableDeliveryPreparationLostError(normalizedId);
  }
  return { id: normalizedId, created: true };
}

export { hasActiveDeliveryOwner } from "./delivery-queue-types.js";

const lostPlatformClaim = (id: string) => new Error(`Delivery platform claim was lost: ${id}`);

/** Update retry evidence on the queue worker's exact namespace and claim. */
export async function failDelivery(
  id: string,
  error: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.mutateOutbound",
    input: { kind: "fail", id, error, expectedPlatformSendAttemptId },
  });
}

export async function failDeliveryBeforePlatformSend(
  id: string,
  error: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.mutateOutbound",
    input: { kind: "fail-before-send", id, error, expectedPlatformSendAttemptId },
  });
}

export async function failDeliveryAfterPlatformSend(
  id: string,
  error: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.mutateOutbound",
    input: { kind: "fail-after-send", id, error, expectedPlatformSendAttemptId },
  });
}

export { claimDeliveryPlatformSendAttempt } from "./delivery-queue-platform-lease.js";

export async function reserveDeliveryAttempt(
  id: string,
  maxAttempts: number,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string,
  context?: DeliveryQueueStateContext,
) {
  return await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.reserveOutbound",
    input: { id, maxAttempts, expectedPlatformSendAttemptId },
  });
}

/** Restore only the exact reserved attempt before recipient-visible dispatch. */
export async function restoreDeliveryAttemptBeforeDispatch(
  entry: QueuedDelivery,
  reservedAttemptCount: number,
  stateDir?: string,
  claimedAttemptId?: string,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.restoreOutbound",
    input: { entry: encodeOutboundDeliverySnapshot(entry), reservedAttemptCount, claimedAttemptId },
  });
}

export async function markDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
  producerClaimId?: string,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.mutateOutbound",
    input: {
      kind: "start",
      id,
      route: route && ("replyToId" in route ? { replyToId: route.replyToId } : {}),
      expectedPlatformSendAttemptId: producerClaimId,
    },
  });
}

export async function markDeliveryPlatformSendDispatched(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
  expectedPlatformSendAttemptId?: string | null,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.mutateOutbound",
    input: {
      kind: "dispatch",
      id,
      route: route && ("replyToId" in route ? { replyToId: route.replyToId } : {}),
      expectedPlatformSendAttemptId,
    },
  });
}

export async function markDeliveryPlatformOutcomeUnknown(
  id: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.mutateOutbound",
    input: { kind: "unknown", id, expectedPlatformSendAttemptId },
  });
}

async function readOutboundDeliveries(
  input: { id?: string; mode: "pending" | "unfinished" },
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<QueuedDelivery[]> {
  const captured = context ?? captureDeliveryQueueStateContext(stateDir);
  const reply = await executeExistingOpenClawStateRead(
    {
      path: captured.workerContext.admission.databasePath,
      env: captured.workerContext.environment,
    },
    { type: "deliveryQueue.outbound", ...input },
    { context: captured.workerContext, current: true },
  );
  captured.workerContext.admission.assertCurrent();
  if (!reply) {
    return [];
  }
  if (!reply.ok || reply.type !== "deliveryQueue.outbound") {
    throw new Error("Unexpected outbound queue read result");
  }
  return reply.entries.map(({ queueName, entry }) => projectOutboundDelivery(queueName, entry));
}

export async function loadPendingDelivery(
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<QueuedDelivery | null> {
  return (await readOutboundDeliveries({ id, mode: "pending" }, stateDir, context))[0] ?? null;
}

/** Includes unfinished settlement in FIFO order across both executable formats. */
export async function loadUnfinishedDeliveries(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<QueuedDelivery[]> {
  return await readOutboundDeliveries({ mode: "unfinished" }, stateDir, context);
}

export async function loadUnfinishedDelivery(
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<QueuedDelivery | null> {
  return (await readOutboundDeliveries({ id, mode: "unfinished" }, stateDir, context))[0] ?? null;
}

/** Close send custody before awaiting completion projection; retain its restart work. */
export async function stageDeliveryFailureSettlement(
  entry: QueuedDelivery,
  settlement: DeliveryFailureSettlement,
  stateDir?: string,
  claimedAttemptId?: string,
  context?: DeliveryQueueStateContext,
): Promise<QueuedDelivery | undefined> {
  const staged = await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.stageFailure",
    input: {
      entry: encodeOutboundDeliverySnapshot(entry),
      settlementEntry: encodeOutboundDeliverySnapshot({ ...entry, settlement }),
      claimedAttemptId,
    },
  });
  return staged && decodeOutboundDeliverySnapshot(staged);
}

export async function finalizeDeliveryFailureSettlement(
  entry: QueuedDelivery,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<boolean> {
  return await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.finalizeFailure",
    input: { entry: encodeOutboundDeliverySnapshot(entry) },
  });
}

/** One-time migration inventory; normal recovery never reads the legacy namespace. */
export function loadLegacyPendingDeliveries(stateDir?: string): LegacyQueuedDelivery[] {
  return loadDeliveryQueueEntries(
    LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
    stateDir,
  ) as LegacyQueuedDelivery[];
}

/** Prepared legacy rows awaiting media staging and canonical publication. */
export function loadPendingDeliveryMigrations(stateDir?: string): QueuedDelivery[] {
  return loadDeliveryQueueEntries(
    OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
    stateDir,
  ) as QueuedDelivery[];
}

/** Claimed pre-D4 rows whose modifying policy has not safely published yet. */
export function loadPendingLegacyDeliveryPreparations(
  stateDir?: string,
): LegacyQueuedDeliveryPreparation[] {
  return loadDeliveryQueueEntries(
    OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    stateDir,
  ) as LegacyQueuedDeliveryPreparation[];
}

/** Move a queue entry out of the pending retry set. */
export async function moveToFailed(
  id: string,
  requestedStateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
  context?: DeliveryQueueStateContext,
): Promise<string[]> {
  const stateDir = context?.stateDir ?? requestedStateDir;
  const entry = await loadPendingDelivery(id, stateDir, context);
  if (!entry) {
    throw new Error(`No pending outbound delivery queue entry ${id}`);
  }
  const result = await failPendingDelivery(
    {
      id,
      entry,
      retainSpoolArtifacts: true,
      ...(expectedPlatformSendAttemptId !== undefined ? { expectedPlatformSendAttemptId } : {}),
    },
    stateDir,
    context,
  );
  if (result.status !== "failed") {
    throw lostPlatformClaim(id);
  }
  return collectEntrySpoolPaths(queuedDeliveryPayloads(entry), stateDir);
}
