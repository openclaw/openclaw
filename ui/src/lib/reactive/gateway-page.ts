import { createEffect, onCleanup, untrack } from "solid-js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { isGatewayAvailable } from "../gateway-availability.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { projectGateway } from "./application.ts";

export type GatewayPageChange = {
  readonly snapshot: ApplicationGatewaySnapshot;
  readonly initial: boolean;
  readonly sourceChanged: boolean;
  readonly clientChanged: boolean;
  readonly connectionChanged: boolean;
  readonly identityChanged: boolean;
  readonly becameConnected: boolean;
  readonly becameAvailable: boolean;
};

type GatewayPageOptions = {
  onIdentityChange?: (change: GatewayPageChange) => void;
  invalidateRequests?: (change: GatewayPageChange) => void;
  ensureInitialData?: (change: GatewayPageChange) => void;
  onSnapshot?: (change: GatewayPageChange) => void;
  onPageActivation?: () => void;
};

/** The projection renders owner facts; its synchronous subscriber fences pending requests. */
export function useGatewayPage(
  context: ApplicationContext | (() => ApplicationContext),
  options: GatewayPageOptions = {},
) {
  const getContext = typeof context === "function" ? context : () => context;
  let currentGateway = getContext().gateway;
  const projection = projectGateway(currentGateway);
  const lifecycle = createGatewayConnectionLifecycle(currentGateway.snapshot);
  let disposed = false;
  let sourceChanged = false;
  let currentSnapshot: ApplicationGatewaySnapshot | null = null;
  let currentClient: ApplicationGatewaySnapshot["client"] = null;
  let connected = false;
  let initial = true;
  const applySnapshot = () => {
    const next = projection.read().snapshot;
    const previousConnected = connected;
    const previousAvailable = currentSnapshot !== null && isGatewayAvailable(currentSnapshot);
    const nextConnected = next.phase === "connected";
    const clientChanged = currentClient !== next.client;
    const changed = lifecycle.transition(next);
    if (sourceChanged && !changed) {
      lifecycle.invalidate();
    }
    currentSnapshot = next;
    currentClient = next.client;
    connected = nextConnected;
    const change: GatewayPageChange = {
      snapshot: next,
      initial,
      sourceChanged,
      clientChanged,
      connectionChanged: previousConnected !== nextConnected,
      identityChanged: !initial && (sourceChanged || clientChanged),
      becameConnected: nextConnected && !previousConnected,
      becameAvailable: isGatewayAvailable(next) && !previousAvailable,
    };
    if (change.identityChanged) {
      options.onIdentityChange?.(change);
    }
    if (!initial && (changed || sourceChanged)) {
      options.invalidateRequests?.(change);
    }
    options.onSnapshot?.(change);
    if (nextConnected && (initial || change.identityChanged || change.connectionChanged)) {
      options.ensureInitialData?.(change);
    }
    initial = false;
  };
  const stop = projection.subscribe(applySnapshot);
  createEffect(
    () => getContext().gateway,
    (nextGateway) => {
      if (nextGateway !== currentGateway) {
        currentGateway = nextGateway;
        sourceChanged = true;
        untrack(() => projection.replaceSource(nextGateway));
        sourceChanged = false;
      }
    },
  );
  // Defer the first callback until callers have assigned the returned page handle.
  queueMicrotask(() => {
    if (!disposed && currentSnapshot === null) {
      applySnapshot();
    }
  });
  const activate = () => options.onPageActivation?.();
  if (options.onPageActivation) {
    document.addEventListener("visibilitychange", activate);
    globalThis.addEventListener("focus", activate);
  }
  onCleanup(() => {
    disposed = true;
    stop();
    lifecycle.dispose();
    document.removeEventListener("visibilitychange", activate);
    globalThis.removeEventListener("focus", activate);
    if (currentSnapshot) {
      options.invalidateRequests?.({
        snapshot: { ...currentSnapshot, client: null, phase: "stopped" },
        initial: false,
        sourceChanged: false,
        clientChanged: currentClient !== null,
        connectionChanged: connected,
        identityChanged: false,
        becameConnected: false,
        becameAvailable: false,
      });
    }
    currentSnapshot = null;
  });
  return {
    get gateway() {
      return currentGateway;
    },
    get snapshot() {
      return projection.read().snapshot;
    },
    get client() {
      return projection.read().snapshot.client;
    },
    get connected() {
      return projection.read().snapshot.phase === "connected";
    },
    get epoch() {
      return lifecycle.epoch;
    },
    capture: () =>
      untrack(() => getContext().gateway === currentGateway) ? lifecycle.capture() : null,
    isCurrent: (scope: Parameters<typeof lifecycle.isCurrent>[0]) =>
      untrack(() => getContext().gateway === currentGateway) && lifecycle.isCurrent(scope),
    invalidate: lifecycle.invalidate,
  };
}
