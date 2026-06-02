import {
  drainPendingDeliveries as coreDrainPendingDeliveries,
  type DeliverFn,
} from "../infra/outbound/delivery-queue.js";

type OutboundDeliverRuntimeModule = typeof import("../infra/outbound/deliver-runtime.js");
type DrainPendingDeliveriesOptions = Omit<
  Parameters<typeof coreDrainPendingDeliveries>[0],
  "deliver"
> & {
  deliver?: DeliverFn;
};

let outboundDeliverRuntimePromise: Promise<OutboundDeliverRuntimeModule> | null = null;

async function loadOutboundDeliverRuntime(): Promise<OutboundDeliverRuntimeModule> {
  // Keep reconnect drains cheap for plugins that inject their own deliver function; load the
  // host outbound delivery runtime only when the SDK facade must supply the default sender.
  outboundDeliverRuntimePromise ??= import("../infra/outbound/deliver-runtime.js");
  return await outboundDeliverRuntimePromise;
}

/** Drain queued outbound payloads, lazily supplying the host delivery runtime when needed. */
export async function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void> {
  const deliver =
    opts.deliver ?? (await loadOutboundDeliverRuntime()).deliverOutboundPayloadsInternal;
  await coreDrainPendingDeliveries({
    ...opts,
    deliver,
  });
}
