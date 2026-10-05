import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { isCronJobActive } from "../active-jobs.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import type { CronRunHistoryWrite, CronRunOverflowCursor } from "./run-history.types.js";
import { isCronRunReceiptOwnerStale } from "./run-receipt-store.js";
import type { CronRuntimeMutationContracts } from "./runtime-mutation.types.js";

/** Original host authority for history that follows an awaited committed mutation. */
export type CronRunHistorySource = {
  context: OpenClawStateWorkerContext;
  storeKey: string;
  defaultAgentId?: string;
  assertCurrent: () => void;
};

const CRON_HISTORY_MAINTENANCE_BATCH = 256;
const CRON_HISTORY_MAINTENANCE_BUDGET_MS = 1_000;

/**
 * One sweep reconciles once, then prunes in short write transactions until a short batch,
 * an abort, or the wall budget. Leftover expired rows resume on the next sweep.
 */
export async function maintainCronRunHistory(
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
  options: { signal?: AbortSignal; budgetMs?: number; batchSize?: number } = {},
): Promise<void> {
  const startedAt = performance.now();
  const budgetMs = options.budgetMs ?? CRON_HISTORY_MAINTENANCE_BUDGET_MS;
  const reconciled: string[] = [];
  const settled: string[] = [];
  let cursors: CronRunOverflowCursor[] = [];
  for (let first = true; ; first = false) {
    const outcome = await runCronHistoryMaintenanceBatch(context, assertCurrent, {
      reconcile: first,
      exclude: reconciled,
      settled,
      cursors,
      limit: options.batchSize ?? CRON_HISTORY_MAINTENANCE_BATCH,
    });
    reconciled.push(...outcome.reconciled);
    settled.push(...outcome.settled);
    ({ cursors } = outcome);
    if (!outcome.more || options.signal?.aborted || performance.now() - startedAt >= budgetMs) {
      return;
    }
  }
}

async function runCronHistoryMaintenanceBatch(
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
  input: CronRuntimeMutationContracts["cron.maintainHistory"]["input"],
): Promise<CronRuntimeMutationContracts["cron.maintainHistory"]["outcome"]> {
  let outcome: CronRuntimeMutationContracts["cron.maintainHistory"]["outcome"] | undefined;
  await runCronRuntimeMutation({
    context,
    type: "cron.maintainHistory",
    input,
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
    publish(value) {
      outcome = value;
    },
  });
  if (!outcome) {
    throw new Error("Cron history maintenance did not publish its outcome");
  }
  return outcome;
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
