import { promisify } from "node:util";
import { serialize } from "node:v8";
import { deflateRaw } from "node:zlib";
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
import type {
  LocalWorkspaceManifestAction,
  LocalWorkspaceManifestValue,
} from "./local-workspace-manifest-scan.js";
import { readLocalWorkspaceCommit } from "./local-workspace-publication.js";
import type {
  LocalWorkspaceManifestMutation,
  LocalWorkspaceMutation,
  LocalWorkspaceProjection,
} from "./local-workspace-store.kernel.js";

export type { LocalWorkspaceProjection } from "./local-workspace-store.kernel.js";

const compressMutation = promisify(deflateRaw);

export async function hasLocalWorkspaceProjection(id: string, env?: NodeJS.ProcessEnv) {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "localWorkspace.exists", input: { id } },
    { current: true, live: true },
  );
  return reply?.exists ?? false;
}

export type LocalWorkspaceStore = {
  signal: AbortSignal;
  workerAuthority: WorktreeWorkerAuthority;
  assertCurrent: () => void;
  get: () => LocalWorkspaceProjection | undefined;
  manifest: (
    row: LocalWorkspaceProjection,
    action: LocalWorkspaceManifestAction,
  ) => Promise<LocalWorkspaceManifestValue>;
  create: (
    row: Omit<LocalWorkspaceProjection, "revision">,
    authority?: WorktreeWorkerAuthority,
  ) => Promise<LocalWorkspaceProjection>;
  update: (
    row: LocalWorkspaceProjection,
    patch: Extract<LocalWorkspaceMutation, { kind: "update" }>["patch"],
    authority?: WorktreeWorkerAuthority,
    manifest?: LocalWorkspaceManifestMutation,
  ) => Promise<LocalWorkspaceProjection>;
  delete: (row: LocalWorkspaceProjection, authority?: WorktreeWorkerAuthority) => Promise<void>;
};

/** The reconciliation lease owns present and absent rows through effects and settlement. */
export function withLocalWorkspaceStore<T>(
  params: {
    worktreeId: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
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
        signal: params.signal,
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
                  const previous = row;
                  const capturedMutation = structuredClone(mutation);
                  const predicates = structuredClone(guard.predicates);
                  // Large inventories repeat paths and tree bookkeeping in their receipts.
                  // Charge the broker for compressed bytes without changing its queue limits.
                  const serialized = serialize(capturedMutation);
                  const compressed =
                    serialized.byteLength > 32 * 1024 * 1024
                      ? await compressMutation(serialized)
                      : undefined;
                  const wireMutation =
                    compressed && compressed.byteLength < serialized.byteLength
                      ? compressed
                      : capturedMutation;
                  let admission: SqliteWorkerOperationAdmission | undefined;
                  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
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
                                mutation: wireMutation,
                                predicates,
                                leases: write.identities,
                              },
                            }),
                          {
                            assertCurrent: assertWrite,
                            createAdmission(operation) {
                              settled = operation.settled;
                              const result = write.createAdmission(operation);
                              admission = result.admission;
                              observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
                                (
                                  context.assertPublicationCurrent ??
                                  context.admission.assertCurrent
                                )();
                                if (facts !== undefined) {
                                  readLocalWorkspaceCommit(
                                    facts,
                                    params.worktreeId,
                                    capturedMutation,
                                    previous,
                                  );
                                }
                              });
                              return result;
                            },
                          },
                        ),
                      { assertCurrent: assertWrite },
                    );
                    row = readLocalWorkspaceCommit(
                      acknowledged,
                      params.worktreeId,
                      capturedMutation,
                      previous,
                    );
                  } catch (error) {
                    const outcome = await settled;
                    if (outcome?.kind === "completed" && admission?.committed) {
                      try {
                        row = readLocalWorkspaceCommit(
                          admission.committed.facts,
                          params.worktreeId,
                          capturedMutation,
                          previous,
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
                  manifest: async (previous, action) => {
                    assertCurrent();
                    if (previous.worktree_id !== params.worktreeId) {
                      throw new Error("Local workspace binding changed");
                    }
                    const result = await executeExistingOpenClawStateRead(
                      { path: context.admission.databasePath, env: context.environment },
                      {
                        type: "localWorkspace.manifest",
                        input: { id: params.worktreeId, revision: previous.revision, action },
                      },
                      { context, current: true, live: true, signal: lease.signal },
                    );
                    assertCurrent();
                    if (!result) {
                      throw new Error("Local workspace manifest is unavailable");
                    }
                    return result.value;
                  },
                  create: async (value, guard) => {
                    await mutate({ kind: "create", row: value }, guard);
                    return row!;
                  },
                  update: async (previous, patch, guard, manifest) => {
                    if (previous.worktree_id !== params.worktreeId) {
                      throw new Error("Local workspace binding changed");
                    }
                    await mutate(
                      { kind: "update", revision: previous.revision, patch, manifest },
                      guard,
                    );
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
