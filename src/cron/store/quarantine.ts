/** Durable malformed-cron recovery records stored in the shared SQLite database. */
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { CronQuarantinedJob, QuarantinedCronConfigJob } from "../types-shared.js";
import { prepareMutableCronStoreKey, resolveCronStoreKeyAsync } from "./paths.js";
import { prepareCronQuarantineRegistration } from "./quarantine.kernel.js";

/** Reads quarantined cron rows without creating or migrating a state database. */
export async function loadCronQuarantinedJobs(
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CronQuarantinedJob[]> {
  const context = captureOpenClawStateWorkerContext({ env });
  const storeKey = await resolveCronStoreKeyAsync(storePath, env, context);
  const reply = await executeExistingOpenClawStateRead(
    { env: context.environment, path: context.admission.databasePath },
    { type: "cron.quarantine", storeKey },
    { context, current: true },
  );
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
  const captured = structuredClone(params);
  const storeKey = await prepareMutableCronStoreKey(captured.storePath, context);
  const input = prepareCronQuarantineRegistration({ ...captured, storePath: storeKey });
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
