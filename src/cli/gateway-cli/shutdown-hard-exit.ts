import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../../infra/runtime-worker-url.js";

export type ShutdownHardExitWatchdog = {
  reportPending: () => void;
  cancel: () => Promise<void>;
};

export function armShutdownHardExitWatchdog(params: {
  delayMs: number;
  describePending?: () => string;
  onError: (error: unknown) => void;
}): ShutdownHardExitWatchdog {
  const delayMs = Math.max(0, Math.floor(params.delayMs));
  const deadlineNs = process.hrtime.bigint() + BigInt(delayMs) * 1_000_000n;
  let pending = params.describePending?.() ?? "unreported";
  const reportError = (error: unknown) => {
    try {
      params.onError(error);
    } catch {
      // Shutdown must retain the main-thread fallback even if warning delivery fails.
    }
  };
  // Worker bootstrap can itself stall. A responsive main thread retains the same deadline.
  const timer = setTimeout(() => {
    try {
      pending = params.describePending?.() ?? pending;
      writeSync(
        2,
        `hard-exit watchdog deadline reached; pending close steps: ${pending}; forcing SIGKILL\n`,
      );
    } finally {
      process.kill(process.pid, "SIGKILL");
    }
  }, delayMs);
  timer.unref();
  let worker: Worker | undefined;
  let exited = Promise.resolve();
  let active = true;
  try {
    const url = resolveRuntimeProcessEntrypointUrl("shutdownHardExit");
    // Keep this safety net independent of the runtime/telemetry cleanup graph.
    worker = new Worker(url, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      workerData: { deadlineNs, pending },
    });
    const ownedWorker = worker;
    exited = new Promise<void>((resolve) => {
      ownedWorker.once("exit", () => resolve());
    });
    // The Gateway's process lease retains required cleanup, not this safety net.
    worker.unref();
    worker.once("error", (error) => {
      if (active) {
        reportError(error);
      }
    });
  } catch (error) {
    reportError(error);
  }

  return {
    reportPending: () => {
      try {
        pending = params.describePending?.() ?? pending;
        worker?.postMessage(pending, []);
      } catch (error) {
        reportError(error);
      }
    },
    cancel: () => {
      clearTimeout(timer);
      active = false;
      try {
        worker?.postMessage("cancel", []);
      } catch (error) {
        reportError(error);
      }
      return exited;
    },
  };
}
