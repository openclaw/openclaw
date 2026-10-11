import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import type { GatewayPageChange } from "../../lit/gateway-page-controller.ts";
import { isGatewayAvailable } from "../gateway-availability.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";

export type { GatewayPageChange } from "../../lit/gateway-page-controller.ts";

/** Solid lifetime for the existing Gateway connection/request owner. */
export function useGatewayPage(options: {
  getGateway: () => ApplicationGateway;
  onIdentityChange?: (change: GatewayPageChange) => void;
  invalidateRequests?: (change: GatewayPageChange) => void;
  ensureInitialData?: (change: GatewayPageChange) => void;
  onSnapshot?: (change: GatewayPageChange) => void;
  onPageActivation?: () => void;
}) {
  const lifecycle = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  let source: ApplicationGateway | null = null;
  let snapshot: ApplicationGatewaySnapshot | null = null;
  let client: ApplicationGatewaySnapshot["client"] = null;
  let connected = false;
  let bound = false;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  function apply(next: ApplicationGatewaySnapshot, initial: boolean, sourceChanged: boolean) {
    const wasAvailable = snapshot !== null && isGatewayAvailable(snapshot);
    const clientChanged = client !== next.client;
    const nextConnected = next.phase === "connected";
    const connectionChanged = connected !== nextConnected;
    const lifecycleChanged = lifecycle.transition(next);
    if (sourceChanged && !lifecycleChanged) {
      lifecycle.invalidate();
    }
    snapshot = next;
    client = next.client;
    connected = nextConnected;
    const change: GatewayPageChange = {
      snapshot: next,
      initial,
      sourceChanged,
      clientChanged,
      connectionChanged,
      identityChanged: !initial && (sourceChanged || clientChanged),
      becameConnected: nextConnected && connectionChanged,
      becameAvailable: isGatewayAvailable(next) && !wasAvailable,
    };
    if (change.identityChanged) {
      options.onIdentityChange?.(change);
    }
    if (!initial && (lifecycleChanged || sourceChanged)) {
      options.invalidateRequests?.(change);
    }
    options.onSnapshot?.(change);
    if (nextConnected && (initial || change.identityChanged || connectionChanged)) {
      options.ensureInitialData?.(change);
    }
    setRevision((value) => value + 1);
  }

  createEffect(options.getGateway, (gateway) => {
    const initial = !bound;
    const sourceChanged = bound && source !== gateway;
    source = gateway;
    bound = true;
    untrack(() => apply(gateway.snapshot, initial, sourceChanged));
    unsubscribe = gateway.subscribe((next) => {
      if (!disposed && source === gateway && options.getGateway() === gateway) {
        untrack(() => apply(next, false, false));
      }
    });
    return () => {
      unsubscribe?.();
      unsubscribe = undefined;
    };
  });
  const activate = () => options.onPageActivation?.();
  if (options.onPageActivation) {
    document.addEventListener("visibilitychange", activate);
    globalThis.addEventListener("focus", activate);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", activate);
      globalThis.removeEventListener("focus", activate);
    });
  }
  onCleanup(() => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    const previous = snapshot;
    source = null;
    snapshot = null;
    const clientChanged = client !== null;
    const connectionChanged = connected;
    client = null;
    connected = false;
    if (previous) {
      const stopped = { ...previous, client: null, phase: "stopped" } as const;
      if (lifecycle.transition(stopped)) {
        untrack(() =>
          options.invalidateRequests?.({
            snapshot: stopped,
            initial: false,
            sourceChanged: false,
            clientChanged,
            connectionChanged,
            identityChanged: false,
            becameConnected: false,
            becameAvailable: false,
          }),
        );
      }
    }
    lifecycle.dispose();
  });
  return {
    get gateway() {
      revision();
      return source;
    },
    get snapshot() {
      revision();
      return snapshot;
    },
    get client() {
      revision();
      return client;
    },
    get connected() {
      revision();
      return connected;
    },
    get epoch() {
      revision();
      return lifecycle.epoch;
    },
    capture: lifecycle.capture,
    isCurrent: lifecycle.isCurrent,
    invalidate: lifecycle.invalidate,
    isRouteDataCurrent(data: {
      gateway: ApplicationGateway;
      gatewaySnapshot: ApplicationGatewaySnapshot;
    }) {
      const gateway = options.getGateway();
      if (data.gateway !== gateway) {
        return false;
      }
      const current = gateway.snapshot;
      return (
        data.gatewaySnapshot === current ||
        (data.gatewaySnapshot.phase === "connected" &&
          current.phase === "connected" &&
          data.gatewaySnapshot.client === current.client &&
          data.gatewaySnapshot.hello !== null &&
          data.gatewaySnapshot.hello === current.hello)
      );
    },
  };
}
