import type { CronJob } from "../../cron/types.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";

// Diagnostics are best effort; an unavailable snapshot must not block a patch.
// Cancellation is not a snapshot failure: it must propagate so an interrupted
// edit cannot advance into the cron.update the caller is about to submit.
export async function resolveDroppedCommandEnvKeys(
  readExistingJob: () => Promise<CronJob>,
  commandEnv: Record<string, string>,
): Promise<string[]> {
  const existing = (
    await readExistingJob().catch((err: unknown) => {
      if (getAsyncWorkSignal()?.aborted && isAbortError(err)) {
        throw err;
      }
      return undefined;
    })
  )?.payload;
  return existing?.kind === "command"
    ? Object.keys(existing.env ?? {}).filter((key) => !Object.hasOwn(commandEnv, key))
    : [];
}
