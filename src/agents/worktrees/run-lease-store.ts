import { SqliteWorkerError, type SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import {
  readWorktreeRegistryWorkerReceipt,
  withWorktreeRegistryPublication,
} from "./registry-publication.js";
import { captureWorktreeRegistryMutation } from "./run-end-lifecycle.js";
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
  let admission: SqliteWorkerOperationAdmission | undefined;
  let mutation: ReturnType<typeof captureWorktreeRegistryMutation> | undefined;
  let failure: { error: unknown } | undefined;
  const ids =
    command.type === "worktrees.reapRunLeases"
      ? command.input.scopes.map((scope) => scope.slice("worktree-run:".length))
      : [command.input.worktreeId];
  try {
    mutation = captureWorktreeRegistryMutation(
      context,
      ids.map((id) => ({ id, fields: ["leases"] })),
      { settlement: command.type === "worktrees.releaseRunLease" },
    );
    const retainedMutation = mutation;
    const { runOpenClawStateWorkerOperation } =
      await import("../../state/openclaw-state-worker-store.js");
    await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
      createAdmission: withWorktreeRegistryPublication((operation) => {
        settled = operation.settled;
        return {
          nativeLocations: [context.admission.databasePath],
          admission: (admission = createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage === "transaction") {
              retainedMutation.observeTransaction();
            }
            context.admission.assertCurrent();
            retainedMutation.assertAuthority(() => assertCurrent?.());
            grant();
          })),
        };
      }, context),
    });
  } catch (error) {
    failure = { error };
  }
  // A rejected delivery can precede failed native cleanup; it does not authorize compensation.
  const outcome = (await settled)?.kind ?? "not-entered";
  mutation?.settle(outcome === "unknown");
  onSettlement?.(outcome);
  if (outcome === "unknown") {
    throw Object.assign(
      new SqliteWorkerError(
        "Worktree run lease outcome is unknown; custody retained",
        "outcome-unknown",
      ),
      { cause: failure?.error },
    );
  }
  if (
    failure &&
    !(outcome === "completed" && readWorktreeRegistryWorkerReceipt(admission?.committed?.facts))
  ) {
    throw failure.error;
  }
}
