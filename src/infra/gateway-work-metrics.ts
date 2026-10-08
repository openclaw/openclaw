import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type GatewayWorkMetricsSnapshot = {
  sessions: { running: number; queued: number };
  work: { agentRuns: number; chatRuns: number; queuedTurns: number };
};

type Listener = (snapshot: GatewayWorkMetricsSnapshot | undefined) => void;

const state = resolveGlobalSingleton<{
  snapshot: GatewayWorkMetricsSnapshot | undefined;
  listeners: Set<Listener>;
  demandListeners: Set<() => void>;
}>(Symbol.for("openclaw.gatewayWorkMetrics"), () => ({
  snapshot: undefined,
  listeners: new Set<Listener>(),
  demandListeners: new Set<() => void>(),
}));

/** The Gateway projection publishes after owner changes and clears on shutdown. */
export function publishGatewayWorkMetrics(snapshot: GatewayWorkMetricsSnapshot | undefined): void {
  state.snapshot = snapshot;
  notifyListeners(state.listeners, snapshot);
}

/** Replay the current projection when an exporter starts or restarts. */
export function onGatewayWorkMetrics(listener: Listener): () => void {
  const wasEmpty = state.listeners.size === 0;
  const unsubscribe = registerListener(state.listeners, listener);
  if (wasEmpty) {
    notifyListeners(state.demandListeners, undefined);
  }
  notifyListeners([listener], state.snapshot);
  return () => {
    const subscribed = state.listeners.has(listener);
    unsubscribe();
    if (subscribed && state.listeners.size === 0) {
      notifyListeners(state.demandListeners, undefined);
    }
  };
}

export function hasGatewayWorkMetricsListeners(): boolean {
  return state.listeners.size > 0;
}

export function onGatewayWorkMetricsDemand(listener: () => void): () => void {
  return registerListener(state.demandListeners, listener);
}
