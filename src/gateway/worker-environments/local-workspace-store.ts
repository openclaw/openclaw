import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  captureWorktreeRunEndContext,
  retainWorktreeRunEndFailure,
  withWorktreeRunEnd,
} from "../../agents/worktrees/run-end-lifecycle.js";
import type { WorktreeWorkerAuthority } from "../../agents/worktrees/types.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawStateLeasesWorkerAdmission } from "../../state/openclaw-state-lease-worker-owner.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  localWorkspacePublication,
  readLocalWorkspaceCommit,
} from "./local-workspace-publication.js";
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
  const mutationWorktreeIds = inherited?.mutationWorktreeIds?.slice();
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
                  guard: WorktreeWorkerAuthority = params.workerAuthority ?? {},
                ) => {
                  assertCurrent();
                  const capturedMutation = structuredClone(mutation);
                  const receipt = randomUUID();
                  let admission: SqliteWorkerOperationAdmission | undefined;
                  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
                  const predicates = structuredClone(guard.predicates);
                  const assertWrite = () => {
                    assertHost();
                    guard.assertCurrent?.();
                  };
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
                              const publication = localWorkspacePublication.begin({
                                get identity() {
                                  return context.admission.identity.key;
                                },
                                assertCurrent:
                                  context.assertPublicationCurrent ??
                                  context.admission.assertCurrent,
                              });
                              observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
                                if (!isRecord(facts) || facts.operationId !== receipt) {
                                  throw new Error("Local workspace receipt changed operation");
                                }
                                publication.committed(facts.receipt);
                              });
                              void operation.settled.then((outcome) =>
                                publication.finish(outcome.kind === "completed"),
                              );
                              return result;
                            },
                          },
                        ),
                      { assertCurrent: assertWrite },
                    );
                    row = acknowledged && Object.freeze(acknowledged);
                  } catch (error) {
                    const outcome = await settled;
                    if (outcome?.kind === "completed" && admission?.committed) {
                      try {
                        row = readLocalWorkspaceCommit(
                          admission.committed.facts,
                          receipt,
                          params.worktreeId,
                        );
                      } catch (receiptError) {
                        active = false;
                        retainWorktreeRunEndFailure(receiptError);
                        throw receiptError;
                      }
                    } else {
                      active = false;
                      retainWorktreeRunEndFailure(error);
                      throw error;
                    }
                  }
                };
                return await run({
                  signal: lease.signal,
                  assertCurrent,
                  workerAuthority: {
                    ...params.workerAuthority,
                    leaseSet: {
                      context,
                      leases,
                      mutationWorktreeIds,
                    },
                    assertCurrent: assertHost,
                  },
                  get: () => {
                    assertHost();
                    return row;
                  },
                  create: async (value, guard) => {
                    await mutate({ kind: "create", row: value }, guard);
                    return row!;
                  },
                  update: async (previous, patch, guard) => {
                    if (previous.worktree_id !== params.worktreeId) {
                      throw new Error("Local workspace binding changed");
                    }
                    await mutate({ kind: "update", revision: previous.revision, patch }, guard);
                    return row!;
                  },
                  delete: async (previous, guard) => {
                    if (previous.worktree_id !== params.worktreeId) {
                      throw new Error("Local workspace binding changed");
                    }
                    await mutate({ kind: "delete", revision: previous.revision }, guard);
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
