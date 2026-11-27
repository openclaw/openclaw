import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { areDiagnosticsEnabledForProcess } from "./diagnostic-events.js";
import type {
  GatewayWsPresenceMode,
  GatewayWsSessionEventAttribution,
} from "./diagnostic-rpc-types.js";

export type GatewayWsMetricsListener = (
  event: string,
  count: number,
  bytes: number,
  wireBytes: number | undefined,
  /** Exclusive bucket counts, borrowed synchronously until the listener returns. */
  buckets: Readonly<ArrayLike<number>>,
  bucketLabels: readonly string[],
  sessionEvent: Readonly<GatewayWsSessionEventAttribution> | undefined,
  presenceMode: GatewayWsPresenceMode | undefined,
) => void;

const listeners = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayWsMetricsListeners"),
  () => new Set<GatewayWsMetricsListener>(),
);

export function onGatewayWsMetrics(listener: GatewayWsMetricsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasGatewayWsMetricsListeners(): boolean {
  return listeners.size > 0;
}

export const publishGatewayWsMetrics: GatewayWsMetricsListener = (
  event,
  count,
  bytes,
  wireBytes,
  buckets,
  bucketLabels,
  sessionEvent,
  presenceMode,
) => {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  for (const listener of listeners) {
    try {
      listener(event, count, bytes, wireBytes, buckets, bucketLabels, sessionEvent, presenceMode);
    } catch {
      // An exporter cannot interrupt transport counter flushing or other subscribers.
    }
  }
};
