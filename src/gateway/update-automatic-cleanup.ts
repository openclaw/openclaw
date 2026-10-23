import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
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

const pending = new Map<string, Promise<UpdateStepResult | undefined>>();

/** Serving-state cleanup stays with its real owner and off the Gateway main thread. */
export function cleanupGatewayUpdateRecovery(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
  assertCallerCurrent: () => void = () => {},
): Promise<UpdateStepResult | undefined> {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const owner = captureGatewayStateOwner(databasePath);
  if (!owner || owner.role !== "gateway") {
    return Promise.resolve(
      automaticRecoveryCleanupWarning(new Error("Gateway does not own the selected state")),
    );
  }
  const assertCurrent = () => {
    assertCallerCurrent();
    owner.assertCurrent();
  };
  const previous = pending.get(databasePath);
  const operation = (async () => {
    await previous?.catch(() => undefined);
    assertCurrent();
    const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
      assertCurrent();
      if (!grant()) {
        throw new Error("Recovery cleanup authority expired");
      }
    });
    const pool = new WorkerTaskPool<AutomaticCleanupInput, UpdateStepResult | undefined>({
      workerUrl: resolveRuntimeProcessEntrypointUrl("updateAutomaticCleanup"),
      maxWorkers: 1,
      maxPendingTasks: 1,
      restartOnError: false,
    });
    let result: UpdateStepResult | undefined;
    try {
      result = await pool.run(
        { runId, env: { ...env }, authority: admission.port },
        {
          transferList: (input) => [input.authority],
          signal: owner.signal,
        },
      );
    } catch (error) {
      result = automaticRecoveryCleanupWarning(error);
    } finally {
      try {
        await pool.close();
      } finally {
        admission.finish();
      }
    }
    return result;
  })()
    .catch((error: unknown) => automaticRecoveryCleanupWarning(error))
    .then((result) => recordAutomaticRecoveryCleanup(runId, result, env, assertCurrent));
  pending.set(databasePath, operation);
  void operation.finally(() => {
    if (pending.get(databasePath) === operation) {
      pending.delete(databasePath);
    }
  });
  return operation;
}
