import type { Worker } from "node:worker_threads";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../../infra/runtime-worker-url.js";
import { createCpuTrackedWorker } from "../../infra/worker-cpu.js";

export type ShutdownHardExitWatchdog = {
  cancel: () => Promise<void>;
};

export function armShutdownHardExitWatchdog(params: {
  delayMs: number;
  onError: (error: unknown) => void;
}): ShutdownHardExitWatchdog | null {
  const reportError = (error: unknown) => {
    try {
      params.onError(error);
    } catch {
      // Shutdown must retain the main-thread fallback even if warning delivery fails.
    }
  };
  let worker: Worker;
  try {
    const url = resolveRuntimeProcessEntrypointUrl("shutdownHardExit");
    worker = createCpuTrackedWorker(url, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
      workerData: { delayMs: Math.max(0, Math.floor(params.delayMs)) },
    });
  } catch (error) {
    reportError(error);
    return null;
  }

  // The Gateway's process lease retains required cleanup, not this safety net.
  const exited = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
  });
  worker.unref();
  let active = true;
  worker.once("error", (error) => {
    if (active) {
      active = false;
      reportError(error);
    }
  });

  return {
    cancel: () => {
      active = false;
      try {
        worker.postMessage("cancel", []);
      } catch (error) {
        reportError(error);
      }
      return exited;
    },
  };
}
