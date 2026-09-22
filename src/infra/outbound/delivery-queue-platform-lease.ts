import {
  claimDeliveryQueueEntryPlatformSend,
  dispatchDeliveryQueueEntryPlatformSend,
  renewDeliveryQueueEntryPlatformSendLease,
} from "../delivery-queue-sqlite-claim.js";
import type { DeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";

/** Atomically transfer a stable pending producer intent to one platform sender. */
export async function claimDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
  reconciledPlatformSendStartedAt?: number,
  reconciledPlatformSendAttemptId?: string,
  context?: DeliveryQueueStateContext,
): Promise<string | undefined> {
  return claimDeliveryQueueEntryPlatformSend(
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      stateDir,
      ...(reconciledPlatformSendStartedAt !== undefined ? { reconciledPlatformSendStartedAt } : {}),
      ...(reconciledPlatformSendAttemptId !== undefined ? { reconciledPlatformSendAttemptId } : {}),
    },
    context,
  );
}

/** Claim and atomically upgrade a live reusable producer to renewable ownership. */
export async function claimReusableDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<string | undefined> {
  return claimDeliveryQueueEntryPlatformSend(
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      stateDir,
      requiresProducerClaim: true,
    },
    context,
  );
}

/** Extend the exact active producer lease without changing ownership. */
export async function renewDeliveryPlatformSendLease(
  id: string,
  stateDir: string | undefined,
  claimId: string,
  context?: DeliveryQueueStateContext,
): Promise<number | undefined> {
  return renewDeliveryQueueEntryPlatformSendLease(
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      stateDir,
      claimId,
    },
    context,
  );
}

/** Promote or refresh the exact live owner at recipient-visible dispatch. */
export function markOwnedDeliveryPlatformSendDispatched(
  id: string,
  stateDir: string | undefined,
  route: { replyToId?: string | null } | undefined,
  claimId: string,
  context?: DeliveryQueueStateContext,
): void {
  const dispatched = dispatchDeliveryQueueEntryPlatformSend(
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      stateDir,
      route,
      claimId,
    },
    context,
  );
  if (!dispatched) {
    throw new Error(`Delivery platform claim was lost: ${id}`);
  }
}
