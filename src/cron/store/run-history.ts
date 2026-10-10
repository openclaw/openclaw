import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { listActiveCronJobIds } from "../active-jobs.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import type { CronRunHistoryWrite } from "./run-history.types.js";
import { prepareCronReceiptLiveness } from "./run-receipt-store.js";

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
  await runCronRuntimeMutation<"cron.maintainHistory">({
    context,
    type: "cron.maintainHistory",
    input: {},
    assertCurrent,
    policy: (() => {
      const liveness = prepareCronReceiptLiveness();
      const activeJobIds = listActiveCronJobIds();
      return {
        value: { nowMs: Date.now(), activeJobIds, localReceiptIds: liveness.receiptIds },
        assertCurrent(outcome) {
          assertCurrent();
          liveness.assertCurrent(outcome?.liveness);
          const current = listActiveCronJobIds();
          if (
            current.length !== activeJobIds.length ||
            current.some((id) => !activeJobIds.includes(id))
          ) {
            throw new Error("Cron history backing ownership changed before commit");
          }
        },
      };
    })(),
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
    (scope) => scope.execute({ type: "cron.recordRun", input: captured }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}
