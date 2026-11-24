import { deliverPendingDeliveryNotice } from "../../channels/turn/pending-delivery-notice.js";
import type { DeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { settleDurableDelivery } from "./delivery-completion.js";
import type {
  DeliveryFailureSettlement,
  DurableDeliveryCompletion,
} from "./delivery-queue-types.js";

/** Project failed custody to its completion owner and hand off notice debt before compaction. */
export async function settleFailedQueuedDeliveryCompletion(
  deliveryCompletion: DurableDeliveryCompletion,
  settlement: DeliveryFailureSettlement,
  stateDir: string | undefined,
  stateContext: DeliveryQueueStateContext,
): Promise<void> {
  const completion = await settleDurableDelivery(
    deliveryCompletion,
    settlement.outcome === "failed" && settlement.rejectionError !== undefined
      ? { rejectionError: settlement.rejectionError }
      : { platformSendStarted: true },
    stateDir,
    stateContext,
  );
  if (completion.state === "unknown" && deliveryCompletion.kind === "pending-final") {
    // Persisted failure custody prevents answer replay. Hand its existing notice
    // debt to the lifecycle sender before compacting this recovery checkpoint.
    await deliverPendingDeliveryNotice(
      deliveryCompletion.sessionKey,
      deliveryCompletion.storePath,
      deliveryCompletion.agentId,
      deliveryCompletion.intentId,
    );
  }
}
