import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { CronScratchReadCommand, CronScratchSnapshot } from "./scratch-contract.js";
import { cronStoreKey } from "./store/key.js";

/** Keep first-use schema opening and the subsequent read on their existing workers. */
export async function readCronScratchSnapshot(
  storePath: string,
  selector: CronScratchReadCommand["selector"],
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
  admission?: {
    context?: OpenClawStateWorkerContext;
    assertCurrent?: () => void;
    signal?: AbortSignal;
  },
): Promise<CronScratchSnapshot | undefined> {
  const context = admission?.context ?? captureOpenClawStateWorkerContext(options);
  const command: CronScratchReadCommand = {
    type: "cron.scratch",
    storeKey: cronStoreKey(storePath),
    selector: { ...selector },
  };
  const callerCurrent = admission?.assertCurrent;
  const signal = admission?.signal;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    context.admission.assertCurrent();
    callerCurrent?.();
    context.admission.assertCurrent();
  };
  assertCurrent();
  // The old mutable getter initialized missing/older state. Native actor readiness
  // owns that opening; the independent reader never creates or migrates a schema.
  await runOpenClawStateWorkerOperation(context, async () => assertCurrent(), { assertCurrent });
  assertCurrent();
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    command,
    { context, current: true, signal },
  );
  assertCurrent();
  if (!reply?.ok || reply.type !== command.type) {
    throw new Error("Cron scratch read did not return its admitted snapshot");
  }
  return reply.snapshot;
}
