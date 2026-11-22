import { formatErrorMessage } from "../infra/errors.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import type { ProcessExtinctionResult, RunExit } from "../process/supervisor/types.js";
import type { CronStreamOwnerParams } from "./cron-stream-owner-types.js";

export function assertCronStreamExtinction(outcome: ProcessExtinctionResult): void {
  if (outcome?.status === "uncertain") {
    throw new Error(`stream source extinction is unconfirmed: ${outcome.reason}`, {
      cause: outcome,
    });
  }
}

export async function stopCronStreamRun(run: ManagedRun, timeoutMs: number): Promise<void> {
  // Detach first so pipe drains cannot enqueue after the owner starts stopping.
  run.detachOutput?.();
  run.cancel("manual-cancel");
  let timeout: NodeJS.Timeout | undefined;
  try {
    const exited = await Promise.race([
      run.waitForExtinction
        ? run.waitForExtinction().then((outcome) => {
            assertCronStreamExtinction(outcome);
            return true;
          })
        : run.wait().then(
            () => true,
            () => true,
          ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs).unref();
      }),
    ]);
    if (!exited) {
      throw new Error(`stream source did not exit within ${timeoutMs}ms`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Join supervised completion without letting an observer failure escape its owner. */
export async function observeCronStreamRun(params: {
  run: ManagedRun;
  now: () => number;
  logger: Pick<CronStreamOwnerParams["logger"], "warn">;
  jobId: string;
  endOutput: () => void;
  onExit: (exit: RunExit) => Promise<void>;
}): Promise<void> {
  const { run } = params;
  await run
    .wait()
    .then(
      (exit) => {
        params.endOutput();
        return params.onExit(exit);
      },
      (error: unknown) => {
        params.logger.warn(
          { jobId: params.jobId, err: formatErrorMessage(error) },
          "cron-stream: supervised wait failed",
        );
        return params.onExit({
          reason: "spawn-error",
          exitCode: null,
          exitSignal: null,
          durationMs: Math.max(0, params.now() - run.startedAtMs),
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        });
      },
    )
    .catch(() => {
      // The serialized owner already records exit handling failures.
    });
}
