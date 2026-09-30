import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  mutateCronRuntimeRowsInDatabase,
  type CronRuntimeRowsMutation,
} from "../store/runtime-rows.kernel.js";
import type { CronStoreTransactionHooks } from "../store/transaction-hooks.types.js";
import type { CronJob } from "../types.js";
import { publishCronRuntimeRows } from "./runtime-publication.js";
import type { CronServiceState } from "./state.js";

/** Applies committed target rows locally without copying any unrelated store snapshot. */
export function applyCronRuntimeRowsToState(
  state: CronServiceState,
  jobs: Iterable<CronJob>,
  deletedJobIds: Iterable<string> = [],
  opts?: { publish?: boolean },
): void {
  if (!state.store) {
    return;
  }
  const jobsById = new Map([...jobs].map((job) => [job.id, job] as const));
  const deleted = new Set(deletedJobIds);
  const residentJobIds = new Set(state.store.jobs.map((job) => job.id));
  const residentJobs = state.store.jobs
    .filter((job) => !deleted.has(job.id))
    .map((job) => jobsById.get(job.id) ?? job);
  const importedJobs = [...jobsById.values()].filter(
    (job) => !residentJobIds.has(job.id) && !deleted.has(job.id),
  );
  state.store.jobs = [...residentJobs, ...importedJobs];
  if (opts?.publish !== false) {
    publishCronRuntimeRows(state);
  }
}

/** Commits runtime-owned job rows from authoritative values read under SQLite's write lock. */
export function commitCronRuntimeRows<T>(params: {
  state: CronServiceState;
  jobIds: Iterable<string>;
  operationLabel: string;
  transactionHooks?: CronStoreTransactionHooks;
  mutate: CronRuntimeRowsMutation<T>;
}): T {
  const storeKey = cronStoreKey(params.state.deps.storePath);
  const jobIds = new Set(params.jobIds);
  const committed = runOpenClawStateWriteTransaction(
    ({ db }) =>
      mutateCronRuntimeRowsInDatabase({
        database: db,
        storeKey,
        jobIds,
        transactionHooks: params.transactionHooks,
        mutate: params.mutate,
      }),
    {},
    { operationLabel: params.operationLabel },
  );
  if (committed.runHooks) {
    params.transactionHooks?.afterCommit?.();
  }
  if (committed.changed) {
    noteCronJobsStoreCommit(storeKey);
  }
  return committed.value;
}
