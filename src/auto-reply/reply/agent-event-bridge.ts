import { type AgentEventPayload, onAgentEventForRun } from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";

export type AgentEventDeliveryStartOrder = {
  preserveCallbackStartOrder?: boolean;
  schedule: (
    deliver: () => unknown,
    options?: { waitForEarlierDeliveries?: boolean },
  ) => Promise<void>;
};

export function createAgentEventDeliveryStartOrder(options?: {
  preserveCallbackStartOrder?: boolean;
}): AgentEventDeliveryStartOrder {
  let startTail = Promise.resolve();
  let settledTail = Promise.resolve();
  return {
    preserveCallbackStartOrder: options?.preserveCallbackStartOrder ?? true,
    schedule: (deliver, deliveryOptions) => {
      const previousStart = startTail;
      const previousSettlement = settledTail;
      const start = createDeferredCore();
      startTail = start.promise;
      const scheduled = (async () => {
        await previousStart;
        // Completed answers must follow earlier presentation, not merely callback invocation.
        // Ordinary progress retains callback-start ordering across independent streams.
        if (deliveryOptions?.waitForEarlierDeliveries) {
          await previousSettlement;
        }
        let delivery: unknown;
        try {
          delivery = deliver();
        } finally {
          start.resolve();
        }
        await delivery;
      })();
      settledTail = Promise.all([previousSettlement, scheduled.catch(() => undefined)]).then(
        () => undefined,
      );
      return scheduled;
    },
  };
}

export type AgentEventBridgeParams<T> = {
  runId: string;
  suppressed?: boolean;
  read: (evt: AgentEventPayload) => T | undefined;
  deliver?: (payload: T) => unknown;
  startOrder?: AgentEventDeliveryStartOrder;
  waitForEarlierDeliveries?: (payload: T) => boolean;
};

export function createAgentEventBridge<T>(params: AgentEventBridgeParams<T>) {
  const deliver = params.deliver;
  if (!deliver) {
    return {
      unsubscribe: () => undefined,
      drain: async (): Promise<void> => undefined,
    };
  }
  let delivery: Promise<unknown> = Promise.resolve();
  const unsubscribe = onAgentEventForRun(params.runId, (evt) => {
    if (params.suppressed) {
      return;
    }
    const payload = params.read(evt);
    if (payload === undefined) {
      return;
    }
    if (!params.startOrder) {
      delivery = delivery.then(() => deliver(payload)).catch(() => undefined);
      return;
    }
    const previousDelivery = delivery;
    const scheduled = params.startOrder
      .schedule(
        () =>
          params.startOrder?.preserveCallbackStartOrder === false
            ? previousDelivery.then(() => deliver(payload))
            : deliver(payload),
        { waitForEarlierDeliveries: params.waitForEarlierDeliveries?.(payload) },
      )
      .catch(() => undefined);
    // Start ordering stays global; each bridge still owns and drains its callback completion.
    delivery = Promise.all([delivery, scheduled]).then(() => undefined);
  });
  return {
    unsubscribe,
    async drain(): Promise<void> {
      await delivery;
    },
  };
}
