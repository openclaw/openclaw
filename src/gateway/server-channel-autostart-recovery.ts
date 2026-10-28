import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { isChannelStartupSuppressedByEnvironment } from "./server-sidecar-startup-mode.js";

export function createChannelAutostartRecovery(params: {
  getSuppression: () => object | null;
  clearSuppression: () => void;
  tryRecover?: (signal: AbortSignal) => Promise<number | undefined>;
  signal: AbortSignal;
  isClosing?: () => boolean;
  startChannels: () => Promise<void>;
}): (signal?: AbortSignal) => Promise<number | undefined> | undefined {
  let recovery: Promise<number | undefined> | undefined;
  return (signal) => {
    params.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (params.isClosing?.()) {
      throw new Error("Gateway crash-loop recovery is closing");
    }
    if (recovery) {
      return racePromiseWithAbortSignal(recovery, signal);
    }
    const suppression = params.getSuppression();
    if (!suppression) {
      return undefined;
    }
    recovery = (async () => {
      if (!params.tryRecover) {
        throw new Error("Gateway crash-loop recovery has no boot owner");
      }
      const pausedUntilMs = await params.tryRecover(params.signal);
      params.signal.throwIfAborted();
      if (params.isClosing?.() || params.getSuppression() !== suppression) {
        throw new Error("Gateway crash-loop recovery owner changed");
      }
      if (pausedUntilMs !== undefined) {
        return pausedUntilMs;
      }
      params.clearSuppression();
      if (!isChannelStartupSuppressedByEnvironment()) {
        await params.startChannels();
      }
      return undefined;
    })().finally(() => {
      recovery = undefined;
    });
    return racePromiseWithAbortSignal(recovery, signal);
  };
}
