import { prepareCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import { assertSessionWriterDeliveryAuthorized } from "../../auto-reply/reply/session-writer-delivery-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayOperatorAccessDeniedError } from "../../gateway/operator-access-policy.js";
import { parseCommandOwnerReference } from "../../state/user-channel-identities.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export async function buildRecoveryDeliverParams(
  entry: QueuedDelivery,
  cfg: OpenClawConfig,
  stateDir?: string,
  producerClaimId?: string,
  stateContext?: DeliveryQueueStateContext,
) {
  const conversationCompletion =
    entry.deliveryCompletion?.kind === "conversation" ? entry.deliveryCompletion : undefined;
  const pendingFinal =
    entry.deliveryCompletion?.kind === "pending-final" ? entry.deliveryCompletion : undefined;
  let owner: Awaited<ReturnType<typeof prepareCommandOwnerAuthority>> | undefined;
  const rejection = (error: unknown) =>
    new PlatformMessageNotDispatchedError(
      "Original channel owner authorization could not be checked",
      { cause: error, retryable: !(error instanceof GatewayOperatorAccessDeniedError) },
    );
  if (pendingFinal?.commandOwnerReference !== undefined) {
    const reference = parseCommandOwnerReference(pendingFinal.commandOwnerReference);
    if (!reference) {
      throw rejection(new GatewayOperatorAccessDeniedError());
    }
    try {
      owner = await prepareCommandOwnerAuthority(cfg, reference, {
        env: resolveDeliveryQueueStateEnv(stateDir, stateContext),
      });
    } catch (error) {
      // Preparation may lose its process lifetime after reading durable facts.
      throw new PlatformMessageNotDispatchedError(
        "Original channel owner preparation interrupted",
        { cause: error },
      );
    }
    if (!owner.source) {
      throw rejection(new GatewayOperatorAccessDeniedError());
    }
  }
  const assertCurrent = () => {
    try {
      if (pendingFinal?.commandOwnerReference !== undefined && !owner?.isCurrent(cfg)) {
        // A stale capture is not proof that the durable reference was retired.
        throw new Error("Original channel owner capture changed during delivery");
      }
    } catch (error) {
      throw rejection(error);
    }
    assertSessionWriterDeliveryAuthorized(pendingFinal?.sessionWriterDeliveryAuthority);
  };
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
    // Recovery retains completion settlement and reconstructs its original authority at I/O.
    ...(pendingFinal
      ? {
          onDirectAdapterHandoff: async () => assertCurrent(),
          assertDirectAdapterHandoff: assertCurrent,
          onPlatformSendDispatch: async () => assertCurrent(),
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
