import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { ClawRemoveStateWorkerOperations } from "./remove-state-worker-contract.js";
import {
  executeClawMutationStateCommand,
  type ClawMutationStateOptions,
} from "./state-mutation-write.js";

export async function assertNoAgentDatabaseLeasesForClawMonitor(
  agentId: string,
  operationId: string,
  options: ClawMutationStateOptions,
): Promise<void> {
  await executeClawMutationStateCommand(options, {
    type: "claws.monitors.assertNoAgentLeases",
    input: { agentId, operationId },
  });
}

export async function quiesceClawMonitorsUnderStateFence(
  input: ClawRemoveStateWorkerOperations["claws.monitors.quiesce"]["input"],
  cancel: () => void,
  options: ClawMutationStateOptions,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext(options);
  let cancelled = false;
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "claws.monitors.quiesce", input }),
    {
      assertCurrent: options.assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Claw monitor cancellation requires transaction admission.");
          }
          context.admission.assertCurrent();
          options.assertCurrent?.();
          if (request.stage === "commit") {
            const facts = request.facts;
            if (
              !facts ||
              typeof facts !== "object" ||
              !("kind" in facts) ||
              facts.kind !== "claw-monitor-quiesce" ||
              !("agentId" in facts) ||
              facts.agentId !== input.agentId ||
              !("operationId" in facts) ||
              facts.operationId !== input.operationId
            ) {
              throw new Error("Claw monitor cancellation has no matching state-worker proof.");
            }
            // The worker still holds its verified write transaction until this grant returns.
            cancel();
            cancelled = true;
          }
          grant();
        }),
      }),
    },
  );
  if (!cancelled) {
    throw new Error("Claw monitor cancellation was not admitted by the state worker.");
  }
}

export async function closeClawMonitorAgentDatabaseUnderStateFence(
  input: ClawRemoveStateWorkerOperations["claws.monitors.prepareDatabaseClose"]["input"],
  options: ClawMutationStateOptions,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext(options);
  let close: Promise<boolean> | undefined;
  try {
    await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "claws.monitors.prepareDatabaseClose", input }),
      {
        assertCurrent: options.assertCurrent,
        createAdmission: () => ({
          nativeLocations: [context.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== "transaction" && request.stage !== "commit") {
              throw new Error("Claw monitor database closure requires transaction admission.");
            }
            context.admission.assertCurrent();
            options.assertCurrent?.();
            if (request.stage === "commit") {
              const facts = request.facts;
              if (
                !facts ||
                typeof facts !== "object" ||
                !("kind" in facts) ||
                facts.kind !== "claw-monitor-database-close" ||
                !("agentId" in facts) ||
                facts.agentId !== input.agentId ||
                !("operationId" in facts) ||
                facts.operationId !== input.operationId ||
                !("databasePath" in facts) ||
                facts.databasePath !== input.databasePath
              ) {
                throw new Error("Claw monitor database closure has no matching worker proof.");
              }
              // Revocation and close selection start synchronously while the worker holds the fence.
              close = closeOpenClawAgentDatabaseByPathAsync(input.databasePath, input.agentId);
              void close.catch(() => {});
            }
            grant();
          }),
        }),
      },
    );
  } catch (error) {
    await close?.catch(() => {});
    throw error;
  }
  if (!close) {
    throw new Error("Claw monitor database closure was not admitted by the state worker.");
  }
  await close;
}
