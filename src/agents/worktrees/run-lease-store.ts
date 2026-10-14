import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import { runWorktreeRegistryCommand } from "./registry-run-end.js";
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
  let mutation: ReturnType<typeof captureWorktreeRegistryMutation>;
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
  } catch (error) {
    onSettlement?.("not-entered");
    throw error;
  }
  await runWorktreeRegistryCommand(context, (scope) => scope.execute(command), {
    assertCurrent: () => mutation.assertAuthority(() => assertCurrent?.()),
    mutation,
    onSettlement,
    unknownMessage: "Worktree run lease outcome is unknown; custody retained",
    recover: () => ({ value: undefined }),
  });
}
