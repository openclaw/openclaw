import type { RecoveryCleanupReport } from "../commands/doctor-session-sqlite-recovery-inventory.js";
import { captureStateDatabaseAccess } from "../infra/gateway-state-owner.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  automaticRecoveryCleanupWarning,
  recordAutomaticRecoveryCleanup,
} from "../infra/update-automatic-cleanup-result.js";
import type { AutomaticCleanupInput } from "../infra/update-automatic-cleanup.worker.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const pending = new Map<string, Promise<unknown>>();

/** Serving-state cleanup stays with its real owner and off the Gateway main thread. */
function runGatewayRecoveryCleanup<T>(
  selection: Pick<AutomaticCleanupInput, "runId" | "dryRun">,
  env: NodeJS.ProcessEnv,
  assertCallerCurrent: () => void,
  settle?: (work: Promise<T>, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const previous = pending.get(databasePath);
  const operation = captureStateDatabaseAccess(databasePath).then((access) => {
    const owner = access.processOwner;
    if (!owner || owner.role !== "gateway") {
      throw new Error("Gateway does not own the selected state");
    }
    const assertCurrent = () => {
      assertCallerCurrent();
      owner.assertCurrent();
    };
    const work = (async () => {
      await previous?.catch(() => undefined);
      assertCurrent();
      let assertAccess = await access.prepareAccess();
      assertCurrent();
      assertAccess();
      const admission = createSqliteWorkerOperationAdmission(
        (_request, grant) => {
          assertCurrent();
          assertAccess();
          if (!grant()) {
            throw new Error("Recovery cleanup authority expired");
          }
        },
        undefined,
        async () => {
          assertCurrent();
          assertAccess = await access.prepareAccess();
          assertCurrent();
          assertAccess();
        },
      );
      const pool = new WorkerTaskPool<AutomaticCleanupInput, T>({
        workerUrl: resolveRuntimeProcessEntrypointUrl("updateAutomaticCleanup"),
        maxWorkers: 1,
        maxPendingTasks: 1,
        restartOnError: false,
      });
      try {
        return await pool.run(
          { ...selection, env: { ...env }, authority: admission.port },
          { transferList: (input) => [input.authority], signal: owner.signal },
        );
      } finally {
        try {
          await pool.close();
        } finally {
          admission.finish();
        }
      }
    })();
    return settle ? settle(work, assertCurrent) : work;
  });
  pending.set(databasePath, operation);
  const release = () => {
    if (pending.get(databasePath) === operation) {
      pending.delete(databasePath);
    }
  };
  void operation.then(release, release);
  return operation;
}

export async function cleanupGatewayUpdateRecovery(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
  assertCallerCurrent: () => void = () => {},
): Promise<UpdateStepResult | undefined> {
  return runGatewayRecoveryCleanup<UpdateStepResult | undefined>(
    { runId },
    env,
    assertCallerCurrent,
    (work, assertCurrent) =>
      work
        .catch(automaticRecoveryCleanupWarning)
        .then((result) => recordAutomaticRecoveryCleanup(runId, result, env, assertCurrent)),
  ).catch(automaticRecoveryCleanupWarning);
}

/** Explicit cleanup uses manual verification and never invents a successful update run. */
export function cleanupGatewayRecovery(
  dryRun: boolean,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
): Promise<RecoveryCleanupReport> {
  return runGatewayRecoveryCleanup<RecoveryCleanupReport>({ dryRun }, env, assertCurrent);
}
