import type { ActiveEmbeddedRunOwner } from "../agents/embedded-agent.js";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
import { createDeferredCore } from "../shared/deferred.js";

const REALTIME_CONTROL_MAX_PENDING = 8;

export function createRealtimeControlQueue(): BoundedSerialQueue {
  return new BoundedSerialQueue({
    maxPendingCount: REALTIME_CONTROL_MAX_PENDING,
    maxPendingWeight: REALTIME_CONTROL_MAX_PENDING,
  });
}

export type PendingConsult = {
  controller: AbortController;
  controlTarget: Promise<ActiveEmbeddedRunOwner | undefined>;
  resolveControlTarget: (captured: ActiveEmbeddedRunOwner | undefined) => void;
};

export function createPendingTalkConsult(): PendingConsult {
  const targetReady = createDeferredCore<ActiveEmbeddedRunOwner | undefined>();
  return {
    controller: new AbortController(),
    controlTarget: targetReady.promise,
    resolveControlTarget: targetReady.resolve,
  };
}
