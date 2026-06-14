// Delivery queue runtime helpers persist and replay outbound plugin delivery work.
import {
  drainPendingDeliveries as coreDrainPendingDeliveries,
  type DeliverFn,
  type ReconnectDrainResult,
} from "../infra/outbound/delivery-queue.js";

type OutboundDeliverRuntimeModule = typeof import("../infra/outbound/deliver-runtime.js");
type DrainPendingDeliveriesOptions = Omit<
  Parameters<typeof coreDrainPendingDeliveries>[0],
  "deliver"
> & {
  /** Optional delivery implementation for tests or plugin-owned send paths. */
  deliver?: DeliverFn;
};

let outboundDeliverRuntimePromise: Promise<OutboundDeliverRuntimeModule> | null = null;

async function loadOutboundDeliverRuntime(): Promise<OutboundDeliverRuntimeModule> {
  outboundDeliverRuntimePromise ??= import("../infra/outbound/deliver-runtime.js");
  return await outboundDeliverRuntimePromise;
}

/**
 * Drain queued outbound payloads after a channel reconnect or transport recovery.
 * When no deliver function is provided, the heavy outbound delivery runtime is
 * loaded lazily so importing this SDK subpath does not eagerly bind send internals.
 */
export async function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void> {
  await drainPendingDeliveriesWithResult(opts);
}

/**
 * Same as {@link drainPendingDeliveries} but returns the drain result so callers
 * can inspect matched/drained/skippedInProgress counts for cooldown or diagnostics.
 *
 * Additive export; the existing {@link drainPendingDeliveries} void contract is unchanged.
 */
export async function drainPendingDeliveriesWithResult(
  opts: DrainPendingDeliveriesOptions,
): Promise<ReconnectDrainResult> {
  const deliver =
    opts.deliver ?? (await loadOutboundDeliverRuntime()).deliverOutboundPayloadsInternal;
  return await coreDrainPendingDeliveries({
    ...opts,
    deliver,
  });
}
