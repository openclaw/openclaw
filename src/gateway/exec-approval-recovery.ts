import { expectDefined } from "@openclaw/normalization-core";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runWithCapturedWorkerContext } from "../state/openclaw-state-worker-operation.js";
import type {
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
} from "./exec-approval-manager.types.js";
import {
  getOperatorApprovalDetailed,
  isOperatorApprovalStoreOutcomeUnknown,
  type OperatorApprovalKind,
  type OperatorApprovalRecord,
} from "./operator-approval-store.js";

export type ExecApprovalMutationPersistence = ExecApprovalManagerOptions<unknown>["persistence"] & {
  workerContext?: OpenClawStateWorkerContext;
};

/** Bind recovery to the same physical target before the original verdict can yield. */
export function captureExecApprovalMutationPersistence(
  persistence: ExecApprovalManagerOptions<unknown>["persistence"],
): ExecApprovalMutationPersistence {
  const { databaseOptions, runtimeEpoch } = persistence;
  const context = captureOpenClawStateWorkerContext({
    ...databaseOptions,
    path: databaseOptions?.database?.path ?? databaseOptions?.path,
  });
  return {
    runtimeEpoch,
    databaseOptions: { path: context.admission.databasePath, env: context.environment },
    workerContext: context,
  };
}

/** Keep later work inside the original write target's maintenance, schema and coordinator scope. */
export function runWithExecApprovalMutationPersistence<T>(
  persistence: ExecApprovalMutationPersistence,
  operation: () => Promise<T>,
): Promise<T> {
  assertExecApprovalMutationPersistenceCurrent(persistence);
  const context = expectDefined(persistence.workerContext, "Approval mutation worker context");
  return runWithCapturedWorkerContext(context, () =>
    withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, operation),
  );
}

/** Recovery may observe only the original physical owner, including before local publication. */
export function assertExecApprovalMutationPersistenceCurrent(
  persistence: ExecApprovalMutationPersistence,
): void {
  const context = expectDefined(persistence.workerContext, "Approval mutation worker context");
  context.admission.assertCurrent();
  context.maintenanceScope?.assertAdmission();
}

export function assertUncertainExecApprovalPersistenceCurrent(
  error: unknown,
  persistence: ExecApprovalMutationPersistence,
): void {
  try {
    assertExecApprovalMutationPersistenceCurrent(persistence);
  } catch (admissionError) {
    throw new AggregateError(
      [error, admissionError],
      "Approval verdict remains uncertain after readback",
      { cause: admissionError },
    );
  }
}

/** Read the durable winner without retrying a verdict or deciding a pending row. */
export async function readUncertainExecApprovalVerdict<TPayload>(
  error: unknown,
  localRecord: ExecApprovalRecord<TPayload> | undefined,
  kind: OperatorApprovalKind,
  persistence: ExecApprovalMutationPersistence,
): Promise<OperatorApprovalRecord | null | undefined> {
  if (!isOperatorApprovalStoreOutcomeUnknown(error)) {
    return undefined;
  }
  if (!localRecord) {
    return null;
  }
  const { id, createdAtMs } = localRecord;
  const { runtimeEpoch, databaseOptions } = persistence;
  assertUncertainExecApprovalPersistenceCurrent(error, persistence);
  const context = expectDefined(persistence.workerContext, "Approval mutation worker context");
  try {
    const lookup = await runWithCapturedWorkerContext(context, () =>
      withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
        getOperatorApprovalDetailed({
          id,
          nowMs: createdAtMs,
          databaseOptions,
          guard: {
            family: "worker",
            assertCurrent: () => {
              context.admission.assertCurrent();
              context.maintenanceScope?.assertOwnerCurrent();
            },
          },
        }),
      ),
    );
    assertUncertainExecApprovalPersistenceCurrent(error, persistence);
    return lookup.outcome === "found" &&
      lookup.record.id === id &&
      lookup.record.kind === kind &&
      lookup.record.runtimeEpoch === runtimeEpoch &&
      lookup.record.createdAtMs === createdAtMs
      ? lookup.record
      : null;
  } catch (readError) {
    throw new AggregateError(
      [error, readError],
      "Approval verdict remains uncertain after readback",
      { cause: readError },
    );
  }
}
