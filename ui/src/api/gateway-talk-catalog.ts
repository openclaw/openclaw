import {
  isGatewayProtocolResponseError,
  resolveSafeTimeoutDelayMs,
  type GatewayProtocolRequestOptions,
} from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sleepWithAbort } from "@openclaw/retry";

/** Warming retries share one bounded wait and the owning connection's cancellation. */
export async function requestTalkCatalog<T>(
  request: (options: GatewayProtocolRequestOptions) => Promise<T>,
  connectionSignal: AbortSignal,
  options?: GatewayProtocolRequestOptions,
): Promise<T> {
  const timeoutMs = Math.min(
    resolveSafeTimeoutDelayMs(options?.timeoutMs ?? 10_000, { minMs: 0 }),
    10_000,
  );
  const deadline = Date.now() + timeoutMs;
  const signal = options?.signal
    ? AbortSignal.any([options.signal, connectionSignal])
    : connectionSignal;
  let requestOpts = { ...options, signal, timeoutMs };
  for (;;) {
    try {
      return await request(requestOpts);
    } catch (error) {
      if (
        !isGatewayProtocolResponseError(error) ||
        error.gatewayCode !== "UNAVAILABLE" ||
        !error.retryable ||
        !isRecord(error.details) ||
        error.details.reason !== "talk-catalog-warming"
      ) {
        throw error;
      }
      const delay = resolveSafeTimeoutDelayMs(error.retryAfterMs ?? 250, { minMs: 250 });
      if (Date.now() + delay >= deadline) {
        throw error;
      }
      await sleepWithAbort(delay, signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw error;
      }
      requestOpts = { ...options, signal, timeoutMs: remaining };
    }
  }
}
