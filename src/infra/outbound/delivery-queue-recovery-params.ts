import { assertSessionWriterDeliveryAuthorized } from "../../auto-reply/reply/session-writer-delivery-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export function buildRecoveryDeliverParams(
  entry: QueuedDelivery,
  cfg: OpenClawConfig,
  stateDir?: string,
  producerClaimId?: string,
) {
  const conversationCompletion =
    entry.deliveryCompletion?.kind === "conversation" ? entry.deliveryCompletion : undefined;
  const pendingFinalWriterAuthority =
    entry.deliveryCompletion?.kind === "pending-final"
      ? entry.deliveryCompletion.sessionWriterDeliveryAuthority
      : undefined;
  return {
    cfg,
    channel: entry.channel,
    to: entry.to,
    accountId: entry.accountId,
    ...(entry.queuePolicy !== undefined ? { queuePolicy: entry.queuePolicy } : {}),
    ...(entry.requireUnknownSendReconciliation === true
      ? { requireUnknownSendReconciliation: true }
      : {}),
    payloads: acceptedPreparedOutboundEntries(entry.preparedBatch).map(
      (prepared) => prepared.payload,
    ),
    preparedBatch: entry.preparedBatch,
    renderedBatchPlan: entry.renderedBatchPlan,
    threadId: entry.threadId,
    reply: entry.reply,
    formatting: entry.formatting,
    identity: entry.identity,
    bestEffort: entry.bestEffort,
    gifPlayback: entry.gifPlayback,
    forceDocument: entry.forceDocument,
    silent: entry.silent,
    mirror: entry.mirror,
    session: entry.session,
    gatewayClientScopes: entry.gatewayClientScopes,
    preparedMessageId: entry.preparedMessageId,
    // Recovery owns terminal completion because nested delivery only reports
    // process-local evidence that cannot survive another restart.
    ...(conversationCompletion
      ? {
          conversationDeliveryAttemptAuthority: {
            agentId: conversationCompletion.agentId,
            operationId: conversationCompletion.operationId,
            ...(conversationCompletion.storePath
              ? { storePath: conversationCompletion.storePath }
              : {}),
            ...(conversationCompletion.routeFingerprint
              ? { routeFingerprint: conversationCompletion.routeFingerprint }
              : {}),
          },
        }
      : {}),
    // Recovery owns durable terminal settlement, so it cannot forward the
    // completion itself. Reconstruct only its writer fence at the two final
    // transport boundaries used by normal live delivery.
    ...(pendingFinalWriterAuthority
      ? {
          onDirectAdapterHandoff: async () => {
            assertSessionWriterDeliveryAuthorized(pendingFinalWriterAuthority);
          },
          assertDirectAdapterHandoff: () => {
            assertSessionWriterDeliveryAuthorized(pendingFinalWriterAuthority);
          },
          onPlatformSendDispatch: async () => {
            assertSessionWriterDeliveryAuthorized(pendingFinalWriterAuthority);
          },
        }
      : {}),
    deliveryQueueId: entry.id,
    deliveryQueueStateDir: stateDir,
    ...(producerClaimId ? { deliveryProducerClaimId: producerClaimId } : {}),
    ...(entry.requiresProducerClaim === true ? { deliveryProducerLeaseRequired: true } : {}),
    skipQueue: true, // Prevent re-enqueueing during recovery.
    deferredDeliveryAdmissionPassed: true,
    deferCommitHooks: true,
  } satisfies DeliverOutboundPayloadsParams;
}
