import { spawn } from "node:child_process";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import { parseNodeWorkerDesktopLaunchInput } from "../worker/node-desktop-protocol.js";

const DESKTOP_LAUNCH_TIMEOUT_MS = 30_000;

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("node worker desktop launch aborted");
}

/** Directly runs one provider-attested launcher without replay. */
export async function invokeNodeWorkerDesktopLaunch(params: {
  paramsJSON?: string | null;
  signal?: AbortSignal;
}): Promise<{ status: "ready" }> {
  const app = parseNodeWorkerDesktopLaunchInput(params.paramsJSON);
  const signal = params.signal;
  signal?.throwIfAborted();
  const child = spawn(app.executablePath, app.args ?? [], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = createDeferredCore();
  let settled = false;
  const stop = (error: Error): void => {
    if (settled) {
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // The terminal error still owns this one-shot launch result.
    }
    settled = true;
    throw error;
  };
  const onError = (error: Error) => {
    settled = true;
    exited.reject(error);
  };
  const onExit = (code: number | null, terminationSignal: NodeJS.Signals | null) => {
    settled = true;
    if (code === 0) {
      exited.resolve();
    } else {
      exited.reject(
        new Error(
          terminationSignal
            ? `node worker desktop launcher terminated by ${terminationSignal}`
            : `node worker desktop launcher exited with code ${code ?? "unknown"}`,
        ),
      );
    }
  };
  child.once("error", onError);
  child.once("exit", onExit);
  try {
    await raceWithTimeout(
      exited.promise,
      DESKTOP_LAUNCH_TIMEOUT_MS,
      () => stop(new Error("node worker desktop launcher timed out")),
      { ref: false, signal, onAbort: (aborted) => stop(signalError(aborted)) },
    );
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }
  return { status: "ready" };
}
