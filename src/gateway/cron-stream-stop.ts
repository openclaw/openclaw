import type { ManagedRun } from "../process/supervisor/index.js";
import type { ProcessExtinctionResult } from "../process/supervisor/types.js";

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
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (!exited) {
      throw new Error(`stream source did not exit within ${timeoutMs}ms`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
