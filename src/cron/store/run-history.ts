import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { listActiveCronJobIds } from "../active-jobs.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import type { CronRunHistoryWrite } from "./run-history.types.js";

/** Captured storage context and attribution for an already-committed outcome. */
export type CronRunHistorySource = {
  context: OpenClawStateWorkerContext;
  storeKey: string;
  defaultAgentId?: string;
};

export async function maintainCronRunHistory(
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
): Promise<{ nextSweepAtMs: number | null }> {
  let nextSweepAtMs: number | null = null;
  await runCronRuntimeMutation({
    context,
    type: "cron.maintainHistory",
    input: {},
    assertCurrent,
    snapshot: {
      nowMs: Date.now(),
      protectedJobIds: listActiveCronJobIds(),
    },
    publish(outcome) {
      nextSweepAtMs = outcome.nextSweepAtMs;
    },
  });
  return { nextSweepAtMs };
}

export async function recordCronRun(
  input: CronRunHistoryWrite,
  source?: CronRunHistorySource,
): Promise<void> {
  const context = source?.context ?? captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    context.admission.assertCurrent();
  };
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => {
      // Caller retirement after dispatch may race history; committed outcomes remain useful.
      assertCurrent();
      return scope.execute({ type: "cron.recordRun", input });
    },
    { assertCurrent },
  );
}
