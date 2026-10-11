import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { listActiveCronJobIds } from "../active-jobs.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import type { CronRunHistoryWrite } from "./run-history.types.js";
import { listLocallyOwnedCronRunReceiptIds } from "./run-receipt-store.js";

/** Original host authority for history that follows an awaited committed mutation. */
export type CronRunHistorySource = {
  context: OpenClawStateWorkerContext;
  storeKey: string;
  defaultAgentId?: string;
  assertCurrent: () => void;
};

export async function maintainCronRunHistory(
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
): Promise<void> {
  await runCronRuntimeMutation({
    context,
    type: "cron.maintainHistory",
    input: {},
    assertCurrent,
    snapshot: {
      nowMs: Date.now(),
      protectedJobIds: listActiveCronJobIds(),
      locallyOwnedReceiptIds: listLocallyOwnedCronRunReceiptIds(),
    },
    publish() {},
  });
}

export async function recordCronRun(
  input: CronRunHistoryWrite,
  source?: CronRunHistorySource,
): Promise<void> {
  const context = source?.context ?? captureOpenClawStateWorkerContext();
  const captured = structuredClone(input);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    source?.assertCurrent();
  };
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => {
      // Caller retirement after dispatch may race history; committed outcomes remain useful.
      assertCurrent();
      return scope.execute({ type: "cron.recordRun", input: captured });
    },
    { assertCurrent },
  );
}
