import type { DeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import { generateSecureUuid } from "../secure-random.js";

/** Atomically transfer a stable pending producer intent to one platform sender. */
export async function claimDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
  reconciledPlatformSendStartedAt?: number,
  reconciledPlatformSendAttemptId?: string,
  context?: DeliveryQueueStateContext,
): Promise<string | undefined> {
  return executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.claimPlatformSend",
    input: {
      id,
      claimId: generateSecureUuid(),
      ...(reconciledPlatformSendStartedAt !== undefined ? { reconciledPlatformSendStartedAt } : {}),
      ...(reconciledPlatformSendAttemptId !== undefined ? { reconciledPlatformSendAttemptId } : {}),
    },
  });
}

/** Claim and atomically upgrade a live reusable producer to renewable ownership. */
export async function claimReusableDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<string | undefined> {
  return executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.claimPlatformSend",
    input: {
      id,
      claimId: generateSecureUuid(),
      requiresProducerClaim: true,
    },
  });
}

/** Extend the exact active producer lease without changing ownership. */
export async function renewDeliveryPlatformSendLease(
  id: string,
  stateDir: string | undefined,
  claimId: string,
  context?: DeliveryQueueStateContext,
): Promise<number | undefined> {
  return executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.renewPlatformSendLease",
    input: {
      id,
      claimId,
    },
  });
}
