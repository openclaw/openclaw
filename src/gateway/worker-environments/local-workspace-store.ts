import { randomUUID } from "node:crypto";
import {
  captureWorktreeRunEndContext,
  retainWorktreeRunEndFailure,
  withWorktreeRunEnd,
} from "../../agents/worktrees/run-end-lifecycle.js";
import type { WorktreeWorkerAuthority } from "../../agents/worktrees/types.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { verifyOpenClawStateLeaseOwnership } from "../../state/openclaw-state-lease-storage.js";
import { withOpenClawStateLeasesWorkerAdmission } from "../../state/openclaw-state-lease-worker-owner.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type {
  LocalWorkspaceMutation,
  LocalWorkspaceProjection,
} from "./local-workspace-store.kernel.js";

export type { LocalWorkspaceProjection } from "./local-workspace-store.kernel.js";

export async function hasLocalWorkspaceProjection(id: string, env?: NodeJS.ProcessEnv) {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "localWorkspace.exists", input: { id } },
    { current: true, live: true },
  );
  if (!reply) {
    return false;
  }
  if (!reply.ok || reply.type !== "localWorkspace.exists") {
    throw new Error("Unexpected local workspace result");
  }
  return reply.exists;
}

export type LocalWorkspaceStore = {
  signal: AbortSignal;
  workerAuthority: WorktreeWorkerAuthority;
  assertCurrent: () => void;
  get: () => LocalWorkspaceProjection | undefined;
  create: (
    row: Omit<LocalWorkspaceProjection, "revision">,
    authority?: WorktreeWorkerAuthority,
  ) => Promise<LocalWorkspaceProjection>;
  update: (
    row: LocalWorkspaceProjection,
    patch: Extract<LocalWorkspaceMutation, { kind: "update" }>["patch"],
    authority?: WorktreeWorkerAuthority,
  ) => Promise<LocalWorkspaceProjection>;
  delete: (row: LocalWorkspaceProjection, authority?: WorktreeWorkerAuthority) => Promise<void>;
};

/** The reconciliation lease owns present and absent rows through effects and settlement. */
export function withLocalWorkspaceStore<T>(
  params: {
    worktreeId: string;
    env?: NodeJS.ProcessEnv;
    assertCurrent?: () => void;
    workerAuthority?: WorktreeWorkerAuthority;
    requireAbsent?: boolean;
  },
  run: (store: LocalWorkspaceStore) => Promise<T>,
): Promise<T> {
  const env = params.env ?? process.env;
  const captured = captureWorktreeRunEndContext(env);
  const inherited = params.workerAuthority?.leaseSet;
  const context = inherited?.context ?? captured;
  if (context.admission.coordinationKey !== captured.admission.coordinationKey) {
    throw new Error("Local workspace lease belongs to another database");
  }
  return withWorktreeRunEnd(env, () =>
    withOpenClawStateLeaseAsync(
      {
        scope: "workspace.local-reconciliation",
        key: params.worktreeId,
        leaseMs: 60_000,
        waitMs: 600_000,
        leaseLabel: "local sandbox workspace",
        operationLabel: "workspace.local-reconciliation",
      },
      context,
      (lease) => {
        const leases = [...(inherited?.leases ?? []), lease];
        return withOpenClawStateLeasesWorkerAdmission(leases, context, async (authority) => {
          let active = true;
          let pending = false;
          const assertHost = () => {
            captured.admission.assertCurrent();
            authority.assertCurrent();
            if (!active) {
              throw new Error("Local workspace custody has ended");
            }
            (params.workerAuthority
              ? params.workerAuthority.assertCurrent
              : params.assertCurrent)?.();
          };
          const assertCurrent = () => {
            assertHost();
            if (pending) {
              throw new Error("Local workspace publication has not settled");
            }
            for (const identity of authority.identities) {
              verifyOpenClawStateLeaseOwnership({
                ...identity,
                leaseLabel: "local sandbox workspace",
                database: {
                  scope: "shared",
                  options: { path: context.admission.databasePath, env: context.environment },
                },
              });
            }
            params.assertCurrent?.();
          };
          try {
            return await runOpenClawStateWorkerOperation(
              context,
              async () => {
                const reply = await executeExistingOpenClawStateRead(
                  { path: context.admission.databasePath, env: context.environment },
                  {
                    type: params.requireAbsent ? "localWorkspace.exists" : "localWorkspace.get",
                    input: { id: params.worktreeId },
                  },
                  { context, current: true, live: true },
                );
                if (
                  reply &&
                  (!reply.ok ||
                    reply.type !==
                      (params.requireAbsent ? "localWorkspace.exists" : "localWorkspace.get"))
                ) {
                  throw new Error("Unexpected local workspace result");
                }
                assertCurrent();
                if (reply?.type === "localWorkspace.exists" && reply.exists) {
                  throw new Error(
                    "Snapshot retains local workspace projection custody; preserve its recovery data",
                  );
                }
                let row =
                  reply?.type === "localWorkspace.get" && reply.row
                    ? Object.freeze(reply.row)
                    : undefined;
                const mutate = async (
                  mutation: LocalWorkspaceMutation,
                  next: LocalWorkspaceProjection | undefined,
                  guard: WorktreeWorkerAuthority = params.workerAuthority ?? {},
                ) => {
                  assertCurrent();
                  const capturedMutation = structuredClone(mutation);
                  const postimage = next && Object.freeze(structuredClone(next));
                  const receipt = randomUUID();
                  let admission: SqliteWorkerOperationAdmission | undefined;
                  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
                  const predicates = structuredClone(guard.predicates);
                  const assertWrite = () => {
                    assertHost();
                    guard.assertCurrent?.();
                  };
                  pending = true;
                  try {
                    const acknowledged = await withOpenClawStateLeasesWorkerAdmission(
                      leases,
                      context,
                      (write) =>
                        runOpenClawStateWorkerOperation(
                          context,
                          (scope) =>
                            scope.execute({
                              type: "localWorkspace.mutate",
                              input: {
                                id: params.worktreeId,
                                mutation: capturedMutation,
                                predicates,
                                leases: write.identities,
                                receipt,
                              },
                            }),
                          {
                            assertCurrent: assertWrite,
                            createAdmission(operation) {
                              settled = operation.settled;
                              const result = write.createAdmission(operation);
                              admission = result.admission;
                              return result;
                            },
                          },
                        ),
                      { assertCurrent: assertWrite },
                    );
                    row = acknowledged && Object.freeze(acknowledged);
                  } catch (error) {
                    const outcome = await settled;
                    if (outcome?.kind === "completed" && admission?.committed?.facts === receipt) {
                      row = postimage;
                    } else {
                      active = false;
                      retainWorktreeRunEndFailure(error);
                      throw error;
                    }
                  } finally {
                    pending = false;
                  }
                };
                return await run({
                  signal: lease.signal,
                  assertCurrent,
                  workerAuthority: {
                    ...params.workerAuthority,
                    leaseSet: { context, leases },
                    assertCurrent: assertHost,
                  },
                  get: () => {
                    assertHost();
                    if (pending) {
                      throw new Error("Local workspace publication has not settled");
                    }
                    return row;
                  },
                  create: async (value, guard) => {
                    const next = { ...value, revision: 0 };
                    await mutate({ kind: "create", row: value }, next, guard);
                    return row!;
                  },
                  update: async (previous, patch, guard) => {
                    if (previous.worktree_id !== params.worktreeId) {
                      throw new Error("Local workspace binding changed");
                    }
                    await mutate(
                      { kind: "update", revision: previous.revision, patch },
                      {
                        ...previous,
                        ...patch,
                        worktree_id: params.worktreeId,
                        revision: previous.revision + 1,
                      },
                      guard,
                    );
                    return row!;
                  },
                  delete: async (previous, guard) => {
                    if (previous.worktree_id !== params.worktreeId) {
                      throw new Error("Local workspace binding changed");
                    }
                    await mutate({ kind: "delete", revision: previous.revision }, undefined, guard);
                  },
                });
              },
              { assertCurrent: assertHost },
            );
          } finally {
            active = false;
          }
        });
      },
    ),
  );
}
