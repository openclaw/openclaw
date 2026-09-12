import { AsyncLocalStorage } from "node:async_hooks";
import {
  shouldRetryReplyDispatch,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatch-outcome.js";

type BlockReplyDelivery = { outcome: ReplyDispatchDeliveryOutcome; pending?: boolean };

export function hasBlockReplyDeliveryCustody(delivery: BlockReplyDelivery): boolean {
  return (
    delivery.pending === true ||
    (delivery.outcome !== "delivered" && !shouldRetryReplyDispatch(delivery.outcome))
  );
}

// Invocation identity survives payload normalization without changing channel callback contracts.
const deliveries = new AsyncLocalStorage<{ settlement?: Promise<BlockReplyDelivery> }>();

export function setBlockReplyDelivery(delivery: Promise<BlockReplyDelivery>): void {
  const context = deliveries.getStore();
  if (context) {
    context.settlement = delivery;
  }
}

export async function deliverBlockReply(
  send: () => Promise<void> | void,
): Promise<BlockReplyDelivery> {
  const context: { settlement?: Promise<BlockReplyDelivery> } = {};
  await deliveries.run(context, send);
  // Direct transport callbacks complete delivery themselves; queued dispatch supplies its receipt.
  return context.settlement ?? { outcome: "delivered" };
}
