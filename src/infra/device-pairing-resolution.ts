import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type PairingRequest = { requestId: string; deviceId: string };
export type DevicePairingResolution = "approved" | "rejected" | "superseded" | "expired";
type Waiter = PairingRequest & {
  resolve: (decision: DevicePairingResolution) => void;
  refresh: (expiresAtMs: number) => void;
};

const waiters = resolveGlobalSingleton(
  Symbol.for("openclaw.devicePairingResolutionWaiters"),
  () => new Map<string, Set<Waiter>>(),
);

export function waitForDevicePairingResolution(
  request: PairingRequest,
  options: { expiresAtMs: number; signal: AbortSignal; baseDir?: string },
): Promise<DevicePairingResolution | undefined> {
  if (options.signal.aborted) {
    return Promise.resolve(undefined);
  }
  const stateDir = path.resolve(options.baseDir ?? resolveStateDir());
  const listeners = waiters.get(stateDir) ?? new Set<Waiter>();
  waiters.set(stateDir, listeners);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (decision?: DevicePairingResolution) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      listeners.delete(waiter);
      if (listeners.size === 0) {
        waiters.delete(stateDir);
      }
      resolve(decision);
    };
    const abort = () => finish();
    const refresh = (expiresAtMs: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish("expired"), Math.max(0, expiresAtMs - Date.now()));
      timer.unref();
    };
    const waiter: Waiter = { ...request, resolve: finish, refresh };
    refresh(options.expiresAtMs);
    listeners.add(waiter);
    options.signal.addEventListener("abort", abort, { once: true });
  });
}

export function refreshDevicePairingResolutionWaiters(
  request: PairingRequest,
  expiresAtMs: number,
  baseDir?: string,
): void {
  const listeners = waiters.get(path.resolve(baseDir ?? resolveStateDir()));
  for (const waiter of listeners ?? []) {
    if (waiter.requestId === request.requestId && waiter.deviceId === request.deviceId) {
      waiter.refresh(expiresAtMs);
    }
  }
}

export function publishDevicePairingResolution(
  request: PairingRequest,
  decision: Exclude<DevicePairingResolution, "expired">,
  baseDir?: string,
): void {
  const listeners = waiters.get(path.resolve(baseDir ?? resolveStateDir()));
  for (const waiter of listeners ?? []) {
    if (waiter.requestId === request.requestId && waiter.deviceId === request.deviceId) {
      waiter.resolve(decision);
    }
  }
}
