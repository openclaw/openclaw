import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./context.ts";

export function readSuspensionPhase(
  payload: unknown,
): ApplicationGatewaySnapshot["suspensionPhase"] {
  const phase = asOptionalRecord(payload)?.phase;
  return phase === "accepting" ||
    phase === "preparing" ||
    phase === "draining" ||
    phase === "prepared"
    ? phase
    : undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Gateway wait aborted", "AbortError");
}

export function waitForGatewayClient(
  gateway: Pick<ApplicationGateway, "snapshot" | "subscribe">,
  signal: AbortSignal,
): Promise<GatewayBrowserClient> {
  const current = gateway.snapshot.client;
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  if (current && gateway.snapshot.phase === "connected") {
    return Promise.resolve(current);
  }
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    let settled = false; // A synchronous replay must not retain its abort listener.
    const cleanup = () => {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = gateway.subscribe((snapshot) => {
      if (snapshot.phase === "connected" && snapshot.client) {
        settled = true;
        cleanup();
        resolve(snapshot.client);
      }
    });
    if (settled || signal.aborted) {
      unsubscribe();
    }
  });
}
