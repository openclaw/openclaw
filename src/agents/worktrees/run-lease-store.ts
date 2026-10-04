import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import type { WorktreeRunLeaseRowInput } from "./run-lease-store.kernel.js";

export async function admitWorktreeRunLeaseRowAsync(
  context: OpenClawStateWorkerContext,
  input: WorktreeRunLeaseRowInput,
  onSettlement: (kind: SqliteWorkerOperationSettlement["kind"]) => void,
): Promise<void> {
  await runLeaseCommand(context, { type: "worktrees.admitRunLease", input }, onSettlement);
  context.admission.assertCurrent();
}

export async function releaseWorktreeRunLeaseRowAsync(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
  context: OpenClawStateWorkerContext = captureOpenClawStateWorkerContext({ env }),
): Promise<void> {
  await runLeaseCommand(context, {
    type: "worktrees.releaseRunLease",
    input: { worktreeId, token },
  });
}

export async function reapWorktreeRunLeases(
  env: NodeJS.ProcessEnv,
  scopes: string[],
  assertCurrent?: () => void,
): Promise<void> {
  if (scopes.length > 0) {
    await runLeaseCommand(
      captureOpenClawStateWorkerContext({ env }),
      { type: "worktrees.reapRunLeases", input: { scopes } },
      undefined,
      assertCurrent,
    );
  }
}

async function runLeaseCommand(
  context: OpenClawStateWorkerContext,
  command: SqliteWorkerCommand<
    Pick<
      OpenClawStateWorkerOperations,
      "worktrees.admitRunLease" | "worktrees.releaseRunLease" | "worktrees.reapRunLeases"
    >
  >,
  onSettlement?: (kind: SqliteWorkerOperationSettlement["kind"]) => void,
  assertCurrent?: () => void,
): Promise<void> {
  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
  try {
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
      createAdmission: (operation) => {
        settled = operation.settled;
        return {
          nativeLocations: [context.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((_request, grant) => {
            context.admission.assertCurrent();
            assertCurrent?.();
            grant();
          }),
        };
      },
    });
  } finally {
    // A rejected delivery can precede failed native cleanup; it does not authorize compensation.
    onSettlement?.((await settled)?.kind ?? "not-entered");
  }
}
