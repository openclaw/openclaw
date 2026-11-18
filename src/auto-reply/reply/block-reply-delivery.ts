import { AsyncLocalStorage } from "node:async_hooks";
import { copyReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { BlockReplySource } from "./block-reply-source.types.js";
import {
  resolveReplyDispatchErrorOutcome,
  shouldRetryReplyDispatch,
  type ReplyDispatchDeliveryOutcome,
} from "./reply-dispatch-outcome.js";

type BlockReplyDelivery = {
  outcome: ReplyDispatchDeliveryOutcome;
  pending?: boolean;
  source?: BlockReplySource;
};

export function hasBlockReplyDeliveryCustody(delivery: BlockReplyDelivery): boolean {
  return (
    delivery.pending === true ||
    (delivery.outcome !== "delivered" && !shouldRetryReplyDispatch(delivery.outcome))
  );
}

// Invocation identity survives payload normalization without changing channel callback contracts.
type BlockReplyDeliveryContext = {
  settlement?: Promise<BlockReplyDelivery>;
  payload?: ReplyPayload;
  source?: BlockReplySource;
};

const deliveries = new AsyncLocalStorage<BlockReplyDeliveryContext>();

export function setBlockReplyDelivery(
  delivery: Promise<BlockReplyDelivery>,
  payload?: ReplyPayload,
): void {
  const context = deliveries.getStore();
  if (context) {
    context.settlement = delivery;
    context.payload = payload;
  }
}

export function createBlockReplySource(): BlockReplySource {
  const fragments: { payload: ReplyPayload; delivery: BlockReplyDelivery }[] = [];
  let parserComplete = true;
  let pendingRuns = 0;
  let lastDelivery: BlockReplyDelivery | undefined;
  let sequence = Promise.resolve();
  const isDelivered = (delivery: BlockReplyDelivery) =>
    delivery.outcome === "delivered" && !delivery.pending;
  const source: BlockReplySource = {
    get complete() {
      return parserComplete && pendingRuns === 0 && (!lastDelivery || isDelivered(lastDelivery));
    },
    get pending() {
      return (
        pendingRuns > 0 ||
        (lastDelivery !== undefined && hasBlockReplyDeliveryCustody(lastDelivery))
      );
    },
    setComplete(complete) {
      parserComplete = complete;
    },
    run<T>(send: () => Promise<T>): Promise<T | undefined> {
      const outer = deliveries.getStore();
      if (outer) {
        outer.source = source;
      }
      pendingRuns++;
      let delivery: BlockReplyDelivery = { outcome: "cancelled" };
      const context: BlockReplyDeliveryContext = {};
      const operation = sequence.then(() => {
        if (lastDelivery && !isDelivered(lastDelivery)) {
          delivery = lastDelivery;
          return undefined;
        }
        return deliveries.run(context, send);
      });
      const settlement = operation
        .then(() => context.settlement ?? delivery)
        .then(
          (receipt) => {
            if (context.payload) {
              fragments.push({ payload: context.payload, delivery: receipt });
              lastDelivery = receipt;
            }
            return receipt;
          },
          (error: unknown) => {
            lastDelivery = { outcome: resolveReplyDispatchErrorOutcome(error) };
            return lastDelivery;
          },
        )
        .finally(() => {
          pendingRuns--;
        });
      // The next continuation observes the failed receipt instead of bypassing an unsent prefix.
      sequence = settlement.then(() => undefined);
      if (outer) {
        outer.settlement = settlement;
      }
      return operation;
    },
    settle: () => sequence.then(() => lastDelivery ?? { outcome: "delivered" }),
    recoverPartial(payload) {
      let text = payload.text;
      for (const fragment of fragments) {
        if (!isDelivered(fragment.delivery)) {
          break;
        }
        const prefix = fragment.payload.text?.trimStart();
        if (!prefix) {
          continue;
        }
        const remaining = text?.trimStart();
        if (!remaining?.startsWith(prefix)) {
          break;
        }
        text = remaining.slice(prefix.length);
      }
      return copyReplyPayloadMetadata(payload, { ...payload, text: text || undefined });
    },
  };
  return source;
}

export async function recoverBlockReplySources(
  payload: ReplyPayload,
  sources: readonly BlockReplySource[],
): Promise<{ payload: ReplyPayload; delivery?: BlockReplyDelivery }> {
  const receipts = await Promise.all(sources.map((source) => source.settle()));
  const complete = sources.every((source) => source.complete);
  const delivery = complete
    ? { outcome: "delivered" as const }
    : (receipts.find(hasBlockReplyDeliveryCustody) ??
      (sources.some((source) => source.pending)
        ? { outcome: "delivered-not-visible" as const, pending: true }
        : undefined));
  if (delivery) {
    return {
      payload: copyReplyPayloadMetadata(payload, { ...payload, text: undefined }),
      delivery,
    };
  }
  return {
    payload: sources.reduce((remaining, source) => source.recoverPartial(remaining), payload),
  };
}

export async function deliverBlockReply(
  send: () => Promise<void> | void,
): Promise<BlockReplyDelivery> {
  const context: BlockReplyDeliveryContext = {};
  await deliveries.run(context, send);
  // Direct transport callbacks complete delivery themselves; queued dispatch supplies its receipt.
  const delivery = (await context.settlement) ?? { outcome: "delivered" };
  return context.source ? { ...delivery, source: context.source } : delivery;
}
