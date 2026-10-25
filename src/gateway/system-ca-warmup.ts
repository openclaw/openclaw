import { isVitestRuntimeEnv } from "../infra/env.js";
import { formatErrorMessage, hasErrnoCode } from "../infra/errors.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { createCpuTrackedWorker } from "../infra/worker-cpu.js";

const SYSTEM_CA_WARMUP_TIMEOUT_MS = 10_000;

type SystemCaWarmupOptions = {
  log?: { warn: (message: string) => void };
};

type SystemCaWarmupMessage = { ok: true } | { ok: false; error: string };

let macOSSystemCaWarmupPromise: Promise<void> | undefined;

/** Warm Node's effective default CA set without blocking the gateway event loop on macOS. */
async function warmMacOSSystemCaOffMainThread(options: SystemCaWarmupOptions = {}): Promise<void> {
  if (process.platform !== "darwin" || isVitestRuntimeEnv()) {
    return;
  }

  let worker: ReturnType<typeof createCpuTrackedWorker>;
  try {
    const url = resolveRuntimeProcessEntrypointUrl("systemCaWarmup");
    worker = createCpuTrackedWorker(url, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    });
  } catch (error) {
    // CA prewarming is an optimization. Node can still load trust settings lazily.
    const reason = hasErrnoCode(error, "ERR_ACCESS_DENIED")
      ? "Node denied worker-thread permission"
      : `worker creation failed: ${formatErrorMessage(error)}`;
    options.log?.warn(`macOS CA warmup skipped because ${reason}; trust settings will load lazily`);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (warning?: string, terminate = false) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      worker.removeAllListeners();
      // A terminating worker can still report one final error after listener cleanup.
      worker.once("error", () => {});
      if (terminate) {
        void worker.terminate().catch(() => {});
      }
      if (warning) {
        options.log?.warn(warning);
      }
      resolve();
    };

    worker.once("message", (value: SystemCaWarmupMessage) => {
      if (!value.ok) {
        settle(
          `macOS CA warmup failed: ${value.error}; gateway startup will continue and trust settings will load lazily`,
          true,
        );
        return;
      }
      settle();
    });
    worker.once("error", (error: Error) => {
      settle(
        `macOS CA warmup worker failed: ${error.message}; gateway startup will continue and trust settings will load lazily`,
      );
    });
    worker.once("exit", (code: number) => {
      settle(
        `macOS CA warmup worker exited before replying (code ${code}); gateway startup will continue and trust settings will load lazily`,
      );
    });

    const timeout = setTimeout(() => {
      settle(
        `macOS CA warmup timed out after ${SYSTEM_CA_WARMUP_TIMEOUT_MS}ms; gateway startup will continue and trust settings will load lazily`,
        true,
      );
    }, SYSTEM_CA_WARMUP_TIMEOUT_MS);
    timeout.unref?.();

    // A wedged trustd lookup must not keep an otherwise stopped gateway process alive.
    worker.unref();
  });
}

/**
 * One warmup worker runs per process, and every caller awaits its shared completion.
 * The settled promise is retained after success or failure because warmup is only an optimization.
 */
export function beginMacOSSystemCaWarmupOnce(options: SystemCaWarmupOptions = {}): Promise<void> {
  return (macOSSystemCaWarmupPromise ??= warmMacOSSystemCaOffMainThread(options));
}
