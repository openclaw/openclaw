import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";

const DEFAULT_GATEWAY_TICK_INTERVAL_MS = 30_000;
const MIN_GATEWAY_TICK_WATCH_INTERVAL_MS = 1_000;

export function resolveMaxInboundSilenceMs(advertisedTickIntervalMs: number | undefined): number {
  // Retain the bounded stale-tab window advertised by the Gateway.
  const tickIntervalMs = resolveSafeTimeoutDelayMs(
    typeof advertisedTickIntervalMs === "number" &&
      Number.isFinite(advertisedTickIntervalMs) &&
      advertisedTickIntervalMs > 0
      ? advertisedTickIntervalMs
      : DEFAULT_GATEWAY_TICK_INTERVAL_MS,
    { minMs: MIN_GATEWAY_TICK_WATCH_INTERVAL_MS },
  );
  return tickIntervalMs * 2;
}
