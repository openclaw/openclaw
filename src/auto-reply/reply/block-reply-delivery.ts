import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatch-outcome.js";

type BlockReplyDelivery = { outcome: ReplyDispatchDeliveryOutcome; pending?: boolean };

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
