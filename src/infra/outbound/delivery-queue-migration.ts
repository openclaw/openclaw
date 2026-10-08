// One-time pre-D4 queue migration. Normal recovery reads only prepared rows.
import { randomUUID } from "node:crypto";
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import {
  movePendingDeliveryQueueEntryNamespace,
  replacePendingDeliveryQueueEntry,
} from "../delivery-queue-sqlite-namespace.js";
import {
  countPendingDeliveryQueueEntriesForMaintenance,
  terminalizePendingDeliveryQueueEntry,
} from "../delivery-queue-sqlite.js";
import {
  collectPayloadMediaSources,
  resolveOutboundMediaAccessForSend,
} from "./deliver-payload.js";
import { prepareOutboundPayloadBatch } from "./deliver-prepare.js";
import { settleDurableDelivery } from "./delivery-completion.js";
import {
  collectEntrySpoolPaths,
  releaseSpoolArtifacts,
  stageQueuePayloadMedia,
} from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRetention,
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import { projectQueuedDeliveryOptions } from "./delivery-queue-projection.js";
import { reconcileUnknownQueuedDelivery } from "./delivery-queue-reconciliation.js";
import type { RecoveryLogger } from "./delivery-queue-recovery.js";
import {
  loadLegacyPendingDeliveries,
  loadPendingLegacyDeliveryPreparations,
  loadPendingDeliveryMigrations,
  type LegacyQueuedDelivery,
  type LegacyQueuedDeliveryPreparation,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import {
  preparedOutboundPayloads,
  createUnavailablePreparedOutboundBatch,
  mapPreparedOutboundAcceptedPayloads,
  projectPreparedOutboundBatchForStorage,
} from "./prepared-batch.js";
import { normalizeOutboundReplyFacts } from "./reply-policy.js";

const LEGACY_PREPARATION_LEASE_MS = 5 * 60_000;
const LEGACY_PREPARATION_LEASE_RENEW_MS = 30_000;

function withLegacyPreparationLease(
  entry: LegacyQueuedDeliveryPreparation,
  ownerId: string,
): LegacyQueuedDeliveryPreparation {
  return {
    ...entry,
    retainOnFailure: true,
    legacyPreparationOwnerId: ownerId,
    legacyPreparationLeaseExpiresAt: Date.now() + LEGACY_PREPARATION_LEASE_MS,
  };
}

function hasActiveLegacyPreparationLease(entry: LegacyQueuedDeliveryPreparation): boolean {
  return Boolean(
    entry.legacyPreparationOwnerId &&
    typeof entry.legacyPreparationLeaseExpiresAt === "number" &&
    entry.legacyPreparationLeaseExpiresAt > Date.now(),
  );
}

function buildLegacyPreparationParams(entry: LegacyQueuedDelivery, cfg: OpenClawConfig) {
  const reply = normalizeOutboundReplyFacts({
    reply: entry.reply,
    replyToId: entry.replyToId,
    replyToMode: entry.replyToMode,
  });
  return {
    cfg,
    ...projectQueuedDeliveryOptions(entry),
    queuePolicy: entry.queuePolicy,
    requireUnknownSendReconciliation: entry.requireUnknownSendReconciliation,
    payloads: entry.payloads,
    reply,
    replyPayloadSendingHook: entry.replyPayloadSendingHook,
    deliveryCompletion: entry.deliveryCompletion,
    completionRetention: entry.completionRetention,
  } as const;
}

async function prepareLegacyEntryCheckpoint(params: {
  entry: LegacyQueuedDeliveryPreparation;
  ownerId: string;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  hookRunner?: HookRunner;
}): Promise<"checkpointed" | "skipped"> {
  const preparationParams = buildLegacyPreparationParams(params.entry, params.cfg);
  const reply = preparationParams.reply;
  const needsUnknownReconciliation =
    params.entry.recoveryState === "send_attempt_started" ||
    params.entry.recoveryState === "unknown_after_send";
  const legacyUnknownSendReconciliation = needsUnknownReconciliation
    ? await reconcileUnknownQueuedDelivery({
        entry: { ...params.entry, reply },
        payloads: params.entry.payloads,
        cfg: params.cfg,
        warn: (message) => params.log.warn(message),
      })
    : undefined;
  if (
    needsUnknownReconciliation &&
    (legacyUnknownSendReconciliation == null ||
      legacyUnknownSendReconciliation.status === "unresolved")
  ) {
    // The migration owner has no safe canonical payload to publish and startup
    // recovery does not scan this private namespace. Settle payload-free instead
    // of retaining raw content in a permanently hidden pending row.
    await failInterruptedLegacyPreparation({
      entry: params.entry,
      log: params.log,
      stateDir: params.stateDir,
    });
    return "skipped";
  }
  // Shipped rows did not record whether policy ran. The accepted upgrade policy
  // preserves shipped recovery by allowing one final pass only before any provider
  // evidence; migration then removes the raw owner so policy can never rerun again.
  // Sent or partially-sent legacy custody has no trustworthy post-policy snapshot.
  const prepareForReplay =
    !needsUnknownReconciliation ||
    (params.entry.recoveryState === "send_attempt_started" &&
      legacyUnknownSendReconciliation?.status === "not_sent");
  let sourceEntry = params.entry;
  let preparedBatch;
  if (prepareForReplay) {
    let leaseLost = false;
    const replaceSourceEntry = (replacementEntry: LegacyQueuedDeliveryPreparation): boolean => {
      const replaced = replacePendingDeliveryQueueEntry({
        queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
        expectedEntry: sourceEntry,
        replacementEntry,
        stateDir: params.stateDir,
      });
      if (replaced) {
        sourceEntry = replacementEntry;
      }
      return replaced;
    };
    const renewLeaseSafely = (): void => {
      try {
        if (leaseLost) {
          return;
        }
        if (!replaceSourceEntry(withLegacyPreparationLease(sourceEntry, params.ownerId))) {
          leaseLost = true;
        }
      } catch (error) {
        leaseLost = true;
        params.log.warn(
          `Legacy delivery ${params.entry.id} preparation lease renewal failed: ${String(error)}`,
        );
      }
    };
    const leaseTimer = setInterval(renewLeaseSafely, LEGACY_PREPARATION_LEASE_RENEW_MS);
    leaseTimer.unref();
    try {
      preparedBatch = await prepareOutboundPayloadBatch(preparationParams, {
        hookRunner: params.hookRunner,
        onBeforeFirstModifier: async () => {
          if (leaseLost) {
            throw new Error(`Legacy delivery ${params.entry.id} preparation lease was lost`);
          }
          if (
            !replaceSourceEntry({
              ...sourceEntry,
              legacyPreparationState: "modifiers_started",
            })
          ) {
            throw new Error(`Legacy delivery ${params.entry.id} preparation ownership changed`);
          }
        },
      });
      if (leaseLost) {
        throw new Error(`Legacy delivery ${params.entry.id} preparation lease was lost`);
      }
    } catch (error) {
      clearInterval(leaseTimer);
      if (sourceEntry.legacyPreparationState === "modifiers_started") {
        await failInterruptedLegacyPreparation({
          entry: sourceEntry,
          log: params.log,
          stateDir: params.stateDir,
        });
      } else if (!leaseLost) {
        replaceSourceEntry({
          ...sourceEntry,
          legacyPreparationOwnerId: undefined,
          legacyPreparationLeaseExpiresAt: undefined,
        });
      }
      throw error;
    }
    clearInterval(leaseTimer);
  } else {
    preparedBatch = createUnavailablePreparedOutboundBatch(params.entry.payloads.length);
  }
  const acceptedPayloads = preparedOutboundPayloads(preparedBatch);
  const {
    payloads: _legacyPayloads,
    replyPayloadSendingHook: _legacyReplyHook,
    replyToId: _legacyReplyToId,
    replyToMode: _legacyReplyToMode,
    legacyPreparationState: _legacyPreparationState,
    legacyPreparationOwnerId: _legacyPreparationOwnerId,
    legacyPreparationLeaseExpiresAt: _legacyPreparationLeaseExpiresAt,
    ...retained
  } = params.entry;
  let canonicalRetained: typeof retained = retained;
  if (prepareForReplay && needsUnknownReconciliation) {
    const {
      availableAt: _availableAt,
      producerClaimId: _producerClaimId,
      platformSendAttemptId: _platformSendAttemptId,
      platformSendStartedAt: _platformSendStartedAt,
      effectiveReplyToId: _effectiveReplyToId,
      recoveryState: _recoveryState,
      ...resetAttempt
    } = retained;
    // The provider verdict applies only to the shipped attempt. Canonical
    // recovery must create fresh attempt identity before any later send.
    canonicalRetained = resetAttempt;
  }
  const checkpoint: QueuedDelivery = {
    ...canonicalRetained,
    retainOnFailure: true,
    preparedBatch: projectPreparedOutboundBatchForStorage(preparedBatch),
    renderedBatchPlan: createRenderedMessageBatchPlan(acceptedPayloads),
    ...(reply ? { reply } : {}),
    ...(!prepareForReplay &&
    (legacyUnknownSendReconciliation?.status === "sent" ||
      legacyUnknownSendReconciliation?.status === "not_sent")
      ? { legacyUnknownSendReconciliation }
      : {}),
    ...(!prepareForReplay ? { legacyPreparedContentUnavailable: true } : {}),
  };
  const result = movePendingDeliveryQueueEntryNamespace({
    sourceQueueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    destinationQueueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
    expectedSourceEntry: sourceEntry,
    destinationEntry: checkpoint,
    stateDir: params.stateDir,
  });
  if (result !== "moved") {
    params.log.warn(`Legacy delivery ${params.entry.id} preparation deferred: ${result}`);
    return "skipped";
  }
  return "checkpointed";
}

async function failInterruptedLegacyPreparation(params: {
  entry: LegacyQueuedDeliveryPreparation;
  log: RecoveryLogger;
  stateDir?: string;
}): Promise<void> {
  const failed = terminalizePendingDeliveryQueueEntry({
    queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    id: params.entry.id,
    entry: params.entry,
    stateDir: params.stateDir,
  });
  if (failed.status !== "terminalized") {
    params.log.warn(`Legacy delivery ${params.entry.id} preparation owner was already settled`);
    return;
  }
  if (params.entry.deliveryCompletion) {
    try {
      await settleDurableDelivery(
        params.entry.deliveryCompletion,
        { platformSendStarted: true },
        params.stateDir,
      );
    } catch (error) {
      params.log.warn(
        `Legacy delivery ${params.entry.id} interrupted preparation owner could not be marked unknown: ${String(error)}`,
      );
    }
  }
  await releaseSpoolArtifacts(
    collectEntrySpoolPaths(params.entry.payloads, params.stateDir),
    params.stateDir,
  ).catch((error: unknown) => {
    params.log.warn(
      `Legacy delivery ${params.entry.id} failed preparation media cleanup failed: ${String(error)}`,
    );
  });
}

function claimLegacyPreparation(params: {
  entry: LegacyQueuedDelivery;
  ownerId: string;
  stateDir?: string;
  source: "legacy" | "preparing";
}): LegacyQueuedDeliveryPreparation | null {
  const claimed = withLegacyPreparationLease(
    {
      ...params.entry,
      legacyPreparationState: "claimed",
    },
    params.ownerId,
  );
  const acquired =
    params.source === "preparing"
      ? replacePendingDeliveryQueueEntry({
          queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
          expectedEntry: params.entry,
          replacementEntry: claimed,
          stateDir: params.stateDir,
        })
      : movePendingDeliveryQueueEntryNamespace({
          sourceQueueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
          destinationQueueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
          expectedSourceEntry: params.entry,
          destinationEntry: claimed,
          retainSourceCompletionFence:
            params.entry.requiresProducerClaim === true ||
            params.entry.completionRetention !== undefined,
          stateDir: params.stateDir,
        }) === "moved";
  return acquired ? claimed : null;
}

async function finalizePreparedMigration(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
}): Promise<"moved" | "skipped"> {
  const acceptedPayloads = preparedOutboundPayloads(params.entry.preparedBatch);
  const stageForReplay = params.entry.legacyPreparedContentUnavailable !== true;
  let stagedPayloads = acceptedPayloads;
  let mediaStageId: string | undefined;
  let stagedArtifacts: string[] = [];
  if (stageForReplay) {
    const mediaParams = {
      ...params.entry,
      cfg: params.cfg,
      payloads: acceptedPayloads,
    };
    const staged = await stageQueuePayloadMedia({
      payloads: acceptedPayloads,
      mediaAccess: resolveOutboundMediaAccessForSend(
        mediaParams,
        collectPayloadMediaSources(acceptedPayloads),
      ),
      maxBytes: resolveOutboundMediaMaxBytes({
        cfg: params.cfg,
        channel: params.entry.channel,
        accountId: params.entry.accountId,
      }),
      stateDir: params.stateDir,
    });
    if (staged.status !== "staged") {
      params.log.warn(
        `Legacy delivery ${params.entry.id} cannot be migrated: ${staged.reason} is not durable`,
      );
      return "skipped";
    }
    stagedPayloads = staged.payloads;
    mediaStageId = staged.mediaStageId;
    stagedArtifacts = staged.artifacts;
  }
  let stagedArtifactsTransferred = false;
  try {
    const queuedPreparedBatch = mapPreparedOutboundAcceptedPayloads(
      params.entry.preparedBatch,
      stagedPayloads,
    );
    const destination: QueuedDelivery = {
      ...params.entry,
      preparedBatch: queuedPreparedBatch,
      // Media staging rewrites only local custody paths. Provider recovery
      // must retain the pre-staging plan used by the original attempt.
      renderedBatchPlan:
        params.entry.renderedBatchPlan ?? createRenderedMessageBatchPlan(acceptedPayloads),
    };
    const result = movePendingDeliveryQueueEntryNamespace({
      sourceQueueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
      destinationQueueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      expectedSourceEntry: params.entry,
      destinationEntry: destination,
      ...(mediaStageId
        ? {
            stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
            stagingId: mediaStageId,
          }
        : {}),
      stateDir: params.stateDir,
    });
    if (result !== "moved") {
      params.log.warn(`Legacy delivery ${params.entry.id} migration deferred: ${result}`);
      return "skipped";
    }
    stagedArtifactsTransferred = true;
    if (stageForReplay) {
      await releaseSpoolArtifacts(
        collectEntrySpoolPaths(acceptedPayloads, params.stateDir),
        params.stateDir,
      ).catch((error: unknown) => {
        params.log.warn(
          `Legacy delivery ${params.entry.id} moved but old media cleanup failed: ${String(error)}`,
        );
      });
    }
    return "moved";
  } finally {
    if (!stagedArtifactsTransferred) {
      await cancelDeliveryQueueMediaRetention(mediaStageId, params.stateDir);
      await releaseSpoolArtifacts(stagedArtifacts, params.stateDir);
    }
  }
}

type LegacyOutboundDeliveryMigrationResult = {
  moved: number;
  skipped: number;
  remaining: number;
};

const activeLegacyMigrations = new Map<string, Promise<LegacyOutboundDeliveryMigrationResult>>();

/** Migrates every unchanged pre-D4 pending row before canonical recovery scans. */
export async function migrateLegacyPendingOutboundDeliveries(params: {
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  hookRunner?: HookRunner;
}): Promise<LegacyOutboundDeliveryMigrationResult> {
  const migrationKey = params.stateDir ?? "<default-state>";
  return await getOrCreatePromise(
    activeLegacyMigrations,
    migrationKey,
    () => migrateLegacyPendingOutboundDeliveriesOwned(params),
    { evictOnSettled: true },
  );
}

async function migrateLegacyPendingOutboundDeliveriesOwned(params: {
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  hookRunner?: HookRunner;
}): Promise<LegacyOutboundDeliveryMigrationResult> {
  let moved = 0;
  let skipped = 0;
  const ownerId = randomUUID();
  const claimedPreparations: LegacyQueuedDeliveryPreparation[] = [];
  for (const entry of loadPendingLegacyDeliveryPreparations(params.stateDir)) {
    if (hasActiveLegacyPreparationLease(entry)) {
      skipped += 1;
      params.log.info(`Legacy delivery ${entry.id} preparation is leased by another owner`);
      continue;
    }
    if (entry.legacyPreparationState !== "claimed") {
      await failInterruptedLegacyPreparation({
        ...params,
        entry,
      });
      skipped += 1;
      continue;
    }
    const claimed = claimLegacyPreparation({
      entry,
      ownerId,
      stateDir: params.stateDir,
      source: "preparing",
    });
    if (!claimed) {
      skipped += 1;
      params.log.info(`Legacy delivery ${entry.id} preparation ownership changed`);
      continue;
    }
    claimedPreparations.push(claimed);
  }
  for (const entry of loadLegacyPendingDeliveries(params.stateDir)) {
    const claimed = claimLegacyPreparation({
      entry,
      ownerId,
      stateDir: params.stateDir,
      source: "legacy",
    });
    if (!claimed) {
      skipped += 1;
      params.log.warn(`Legacy delivery ${entry.id} could not acquire preparation ownership`);
      continue;
    }
    claimedPreparations.push(claimed);
  }
  for (const entry of claimedPreparations) {
    try {
      if ((await prepareLegacyEntryCheckpoint({ ...params, entry, ownerId })) === "skipped") {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      params.log.warn(`Legacy delivery ${entry.id} migration failed: ${String(error)}`);
    }
  }
  for (const entry of loadPendingDeliveryMigrations(params.stateDir)) {
    try {
      if ((await finalizePreparedMigration({ ...params, entry })) === "moved") {
        moved += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      params.log.warn(`Prepared delivery ${entry.id} migration failed: ${String(error)}`);
    }
  }
  if (moved > 0 || skipped > 0) {
    params.log.info(`Legacy delivery migration settled moved=${moved} skipped=${skipped}`);
  }
  const remaining = countPendingDeliveryQueueEntriesForMaintenance(
    [
      OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
      LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
    ],
    params.stateDir,
  );
  return { moved, skipped, remaining };
}
