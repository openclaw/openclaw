/** Durable malformed-cron recovery records stored in the shared SQLite database. */
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "../types-shared.js";
import { cronStoreKey } from "./key.js";
import { prepareCronQuarantineRegistration } from "./quarantine.kernel.js";

/** Reads quarantined cron rows without creating or migrating a state database. */
export async function loadCronQuarantinedJobs(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CronQuarantinedJob[]> {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "cron.quarantine", storeKey: cronStoreKey(storePath) },
  );
  if (reply && (!reply.ok || reply.type !== "cron.quarantine")) {
    throw new Error("Unexpected cron quarantine observation result");
  }
  return reply?.entries ?? [];
}

/** Await durable registration before callers archive their legacy recovery source. */
export async function saveCronQuarantinedJobs(params: {
  storePath: string;
  entries: readonly (QuarantinedCronConfigJob | CronQuarantinedJob)[];
  nowMs: number;
}): Promise<void> {
  if (params.entries.length === 0) {
    return;
  }
  const context = captureOpenClawStateWorkerContext();
  const input = prepareCronQuarantineRegistration(params);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
  };
  await runOpenClawStateWorkerOperation(context, (scope) => {
    assertCurrent();
    // Retirement may race dispatch; the worker commits without consulting the host.
    return scope.execute({ type: "cron.registerQuarantine", input });
  });
  assertCurrent();
}
