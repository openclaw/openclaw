import { createEffect, createSignal, onCleanup } from "solid-js";
import { GatewayPageBinding, type GatewayPageBindingOptions } from "../gateway-page-binding.ts";

export type { GatewayPageChange } from "../gateway-page-binding.ts";

/** Solid lifetime and reactive reads for the shared connection/request owner. */
export function useGatewayPage(options: GatewayPageBindingOptions) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const binding = new GatewayPageBinding(() => setRevision((value) => value + 1), options);
  let connected = false;
  // The binding owns synchronous request retirement; only source identity is reactive.
  createEffect(options.getGateway, (gateway) => {
    if (connected) {
      binding.refresh(gateway ?? null);
    } else {
      connected = true;
      binding.connect(gateway ?? null);
    }
  });
  onCleanup(() => binding.dispose());
  return {
    get gateway() {
      revision();
      return binding.gateway;
    },
    get snapshot() {
      revision();
      return binding.snapshot;
    },
    get client() {
      revision();
      return binding.client;
    },
    get connected() {
      revision();
      return binding.connected;
    },
    get epoch() {
      revision();
      return binding.epoch;
    },
    readEpoch: () => binding.epoch,
    capture: () => binding.capture(),
    isCurrent: (scope: Parameters<GatewayPageBinding["isCurrent"]>[0]) => binding.isCurrent(scope),
    invalidate: () => binding.invalidate(),
    isRouteDataCurrent: (data: Parameters<GatewayPageBinding["isRouteDataCurrent"]>[0]) =>
      binding.isRouteDataCurrent(data),
  };
}
