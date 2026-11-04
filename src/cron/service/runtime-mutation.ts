import {
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionFactory } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type {
  CronRuntimeMutationContracts,
  CronJobMutationRefusal,
  CronRuntimeMutationType,
  CronRuntimeWorkerOperations,
} from "../store/runtime-worker.types.js";

type CronRuntimeMutationParams<Type extends CronRuntimeMutationType> = {
  context: OpenClawStateWorkerContext;
  type: Type;
  input: CronRuntimeMutationContracts[Type]["input"];
  snapshot: CronRuntimeMutationContracts[Type]["snapshot"];
  assertCurrent: () => void;
  createAdmission?: SqliteWorkerAdmissionFactory;
  publish: (outcome: CronRuntimeMutationContracts[Type]["outcome"]) => void;
  onSettled?: (outcome: "committed" | "not-committed" | "unknown") => void;
  onRolledBackMutation?: (refusal: CronJobMutationRefusal) => never;
};

/** Push policy before dispatch; all current-row decisions remain in the worker. */
export async function runCronRuntimeMutation<Type extends CronRuntimeMutationType>(
  params: CronRuntimeMutationParams<Type>,
): Promise<void> {
  let settled: "committed" | "not-committed" | "unknown" = "not-committed";
  try {
    await runOpenClawStateWorkerOperation(
      params.context,
      async (scope) => {
        // Ordinary cron accepts changes after dispatch. Stream security additionally
        // checks its current caller and policy at native transaction and commit admission.
        const command = {
          type: params.type,
          input: { ...params.input, snapshot: params.snapshot },
          // SAFETY: Type selects this private command's input, snapshot, and outcome together.
        } as SqliteWorkerCommand<CronRuntimeWorkerOperations>;
        settled = "unknown";
        const result = await scope.execute(command).catch((error: unknown) => {
          if (!hasSqliteWorkerOutcomeUnknown(error)) {
            settled = "not-committed";
          }
          throw error;
        });
        if ("outcome" in result) {
          settled = "committed";
          params.publish(result.outcome);
          return;
        }
        settled = "not-committed";
        if ("mutationRefusal" in result && params.onRolledBackMutation) {
          params.onRolledBackMutation(result.mutationRefusal);
        } else {
          throw new Error("Cron mutation returned an unexpected refusal");
        }
      },
      { assertCurrent: params.assertCurrent, createAdmission: params.createAdmission },
    );
  } finally {
    params.onSettled?.(settled);
  }
}
