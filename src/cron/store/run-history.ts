import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { isCronJobActive } from "../active-jobs.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import type { CronRunHistoryWrite } from "./run-history.types.js";
import { isCronRunReceiptOwnerStale } from "./run-receipt-store.js";

export async function maintainCronRunHistory(
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
): Promise<void> {
  await runCronRuntimeMutation({
    context,
    type: "cron.maintainHistory",
    input: {},
    assertCurrent,
    prepare({ jobIds, receipts }) {
      const protectedJobs = () =>
        new Set([
          ...jobIds.filter(isCronJobActive),
          ...receipts
            .filter((receipt) => !isCronRunReceiptOwnerStale(receipt, Date.now()))
            .map((receipt) => receipt.jobId),
        ]);
      const protectedJobIds = protectedJobs();
      return {
        value: { nowMs: Date.now(), protectedJobIds: [...protectedJobIds] },
        assertCurrent() {
          assertCurrent();
          const current = protectedJobs();
          if (
            current.size !== protectedJobIds.size ||
            [...current].some((id) => !protectedJobIds.has(id))
          ) {
            throw new Error("Cron history backing ownership changed before commit");
          }
        },
      };
    },
    publish() {},
  });
}

export async function recordCronRun(input: CronRunHistoryWrite): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  const captured = structuredClone(input);
  const assertCurrent = () => context.admission.assertCurrent();
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
