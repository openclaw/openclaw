// Owns durable outbound admission, immutable payload custody, and media staging.
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { createInitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.js";
import { isDeliveryRecoveryOwnedRetry } from "../delivery-recovery.shared.js";
import { throwSqliteLifecycleErrors } from "../sqlite-coordinator.js";
import type { InternalDeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import {
  collectPayloadMediaSources,
  resolveOutboundMediaAccessForSend,
  stripInternalRuntimeScaffoldingFromPayload,
} from "./deliver-payload.js";
import { resolveConversationDeliveryScope } from "./delivery-completion.js";
import { releaseSpoolArtifacts, stageQueuePayloadMedia } from "./delivery-queue-media-spool.js";
import { cancelDeliveryQueueMediaRetention } from "./delivery-queue-media-staging.js";
import type { StableDeliveryPreparation } from "./delivery-queue-preparation.js";
import {
  loadPendingDelivery,
  type QueuedDelivery,
  enqueueDelivery,
  enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce,
} from "./delivery-queue-storage.js";
import {
  acceptedPreparedOutboundEntries,
  mapPreparedOutboundAcceptedPayloads,
  type PreparedOutboundBatch,
} from "./prepared-batch.js";
import { normalizeOutboundReplyFacts } from "./reply-policy.js";

export function restoreQueuedDeliveryCustody(
  params: InternalDeliverOutboundPayloadsParams,
  entry: QueuedDelivery,
): InternalDeliverOutboundPayloadsParams {
  // A regenerated caller owns current runtime authority, never the durable
  // effect. Recipient, staged payload, and completion stay with the first row.
  const {
    id: _id,
    enqueuedAt: _enqueuedAt,
    retryCount: _retryCount,
    attemptCount: _attemptCount,
    requiresProducerClaim: _requiresProducerClaim,
    availableAt: _availableAt,
    producerClaimId: _producerClaimId,
    lastAttemptAt: _lastAttemptAt,
    lastError: _lastError,
    platformSendAttemptId: _platformSendAttemptId,
    platformSendStartedAt: _platformSendStartedAt,
    effectiveReplyToId: _effectiveReplyToId,
    recoveryState: _recoveryState,
    maxRetries: _maxRetries,
    legacyUnknownSendReconciliation: _legacyUnknownSendReconciliation,
    legacyPreparedContentUnavailable: _legacyPreparedContentUnavailable,
    ...custody
  } = entry;
  const target = params.conversationDeliveryTarget;
  const completion = custody.deliveryCompletion;
  if (target) {
    if (completion?.kind !== "conversation") {
      throw new Error("Conversation delivery target does not match durable custody");
    }
    resolveConversationDeliveryScope(
      completion,
      params.deliveryQueueStateDir,
      params.deliveryQueueStateContext,
      target,
    );
  }
  const payloads = acceptedPreparedOutboundEntries(custody.preparedBatch).map(
    (prepared) => prepared.payload,
  );
  return { ...params, ...custody, payloads };
}

/** Stages producer-owned media and atomically admits one durable outbound intent. */
export async function stageAndEnqueueOutboundDelivery(
  params: InternalDeliverOutboundPayloadsParams,
  preparedBatch: PreparedOutboundBatch,
  options?: {
    getStablePreparation?: () => Promise<StableDeliveryPreparation>;
    claimForLiveDelivery?: boolean;
  },
): Promise<{ id: string; created: boolean; producerClaimId?: string } | null> {
  const { channel, to } = params;
  const stateDir = params.deliveryQueueStateDir;
  const queuePolicy = params.queuePolicy ?? "best_effort";
  const acceptedPayloads = acceptedPreparedOutboundEntries(preparedBatch).map((entry) =>
    stripInternalRuntimeScaffoldingFromPayload(entry.payload),
  );
  const renderedBatchPlan =
    params.renderedBatchPlan ?? createRenderedMessageBatchPlan(acceptedPayloads);

  if (params.deliveryIntentId && params.reusePendingDeliveryIntent) {
    const existing = await loadPendingDelivery(
      params.deliveryIntentId,
      stateDir,
      params.deliveryQueueStateContext,
    );
    if (existing) {
      // Durable custody owns its already-staged media. A regenerated TTS or
      // producer file may have vanished, so claim the row before staging it.
      return { id: existing.id, created: false };
    }
  }
  // A durable row must not outlive its media. Producer-owned local sources
  // (TTS temps above all) are deleted when this process exits, so the queue
  // takes its own copy first and the row references that; the live send below
  // keeps the original path and stays copy-free.
  const staged = await stageQueuePayloadMedia(
    {
      stateDir,
      payloads: acceptedPayloads,
      // Resolved exactly as the live send resolves it: staging must neither
      // reject media the send would deliver (agent workspace sources are only
      // reachable through the agent-scoped roots) nor read more than the send may.
      mediaAccess: resolveOutboundMediaAccessForSend(
        params,
        channel,
        collectPayloadMediaSources(acceptedPayloads),
      ),
      maxBytes: resolveOutboundMediaMaxBytes({
        cfg: params.cfg,
        channel,
        accountId: params.accountId,
      }),
    },
    params.deliveryQueueStateContext,
  );
  if (staged.status !== "staged") {
    // Sensitive media must reach neither the spool nor the row, so there is no
    // replayable copy to promise. Required sends fail closed instead of
    // persisting an unreplayable row; best-effort degrades to a live-only send.
    if (queuePolicy === "required") {
      throw new Error(
        `Required durable message send is unsupported for ${channel}: ${staged.reason} cannot be persisted`,
      );
    }
    return null;
  }
  try {
    const initialProducerClaim = options?.claimForLiveDelivery
      ? createInitialDeliveryProducerClaim()
      : undefined;
    const queuedPreparedBatch = mapPreparedOutboundAcceptedPayloads(preparedBatch, staged.payloads);
    const delivery = {
      channel,
      to,
      accountId: params.accountId,
      queuePolicy,
      requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
      ...(params.reusePendingDeliveryIntent ? { requiresProducerClaim: true } : {}),
      ...(initialProducerClaim ? { initialProducerClaim } : {}),
      preparedBatch: queuedPreparedBatch,
      renderedBatchPlan,
      threadId: params.threadId,
      reply: normalizeOutboundReplyFacts(params),
      formatting: params.formatting,
      identity: params.identity,
      bestEffort: params.bestEffort,
      gifPlayback: params.gifPlayback,
      forceDocument: params.forceDocument,
      silent: params.silent,
      mirror: params.mirror,
      session: params.session,
      gatewayClientScopes: params.gatewayClientScopes,
      preparedMessageId: params.preparedMessageId,
      completionRetention: params.completionRetention,
      maxRetries: params.maxRetries,
      deliveryCompletion: params.deliveryCompletion,
    };
    if (params.deliveryIntentId) {
      const queued = options?.getStablePreparation
        ? await enqueuePreparedDeliveryOnce(
            delivery,
            params.deliveryIntentId,
            await options.getStablePreparation(),
            stateDir,
            staged.mediaStageId,
            params.deliveryQueueStateContext,
          )
        : await enqueueDeliveryOnce(
            delivery,
            params.deliveryIntentId,
            stateDir,
            staged.mediaStageId,
            params.deliveryQueueStateContext,
          );
      if (!queued.created) {
        cancelDeliveryQueueMediaRetention(
          staged.mediaStageId,
          stateDir,
          params.deliveryQueueStateContext,
        );
        await releaseSpoolArtifacts(staged.artifacts, stateDir);
      }
      return {
        ...queued,
        ...(queued.created && initialProducerClaim
          ? { producerClaimId: initialProducerClaim.producerClaimId }
          : {}),
      };
    }
    const id = await enqueueDelivery(
      delivery,
      stateDir,
      staged.mediaStageId,
      params.deliveryQueueStateContext,
    );
    return {
      id,
      created: true,
      ...(initialProducerClaim ? { producerClaimId: initialProducerClaim.producerClaimId } : {}),
    };
  } catch (err) {
    if (isDeliveryRecoveryOwnedRetry(err)) {
      throw err;
    }
    const errors: unknown[] = [err];
    try {
      cancelDeliveryQueueMediaRetention(
        staged.mediaStageId,
        stateDir,
        params.deliveryQueueStateContext,
      );
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      await releaseSpoolArtifacts(staged.artifacts, stateDir);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    throwSqliteLifecycleErrors(errors, "Delivery queue admission and media cleanup failed");
    throw err;
  }
}
