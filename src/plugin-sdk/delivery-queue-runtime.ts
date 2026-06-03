import {
  drainPendingDeliveries as coreDrainPendingDeliveries,
  type DeliverFn,
} from "../infra/outbound/delivery-queue.js";

type OutboundDeliverRuntimeModule = typeof import("../infra/outbound/deliver-runtime.js");
type DrainPendingDeliveriesOptions = Omit<
  Parameters<typeof coreDrainPendingDeliveries>[0],
  "deliver"
> & {
  /** Optional test/plugin-owned sender; omitted callers get the core outbound runtime lazily. */
  deliver?: DeliverFn;
};

let outboundDeliverRuntimePromise: Promise<OutboundDeliverRuntimeModule> | null = null;

async function loadOutboundDeliverRuntime(): Promise<OutboundDeliverRuntimeModule> {
  // Cache the dynamic import so reconnect drains do not reload the outbound runtime boundary.
  outboundDeliverRuntimePromise ??= import("../infra/outbound/deliver-runtime.js");
  return await outboundDeliverRuntimePromise;
}

/** Drain queued outbound payloads without statically pulling the full delivery runtime into plugins. */
export async function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void> {
  const deliver =
    opts.deliver ?? (await loadOutboundDeliverRuntime()).deliverOutboundPayloadsInternal;
  await coreDrainPendingDeliveries({
    ...opts,
    deliver,
  });
}
