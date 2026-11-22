import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { serialize } from "node:v8";
import { constants, deflateRawSync, zstdCompress } from "node:zlib";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { resolveAgentRunErrorLifecycleFields } from "../../agents/run-termination.js";
import type { LocalWorkspacePauseReason } from "../../agents/sandbox/local-workspace-quiescence.js";
import type { LocalWorkspacePausePhase } from "../../agents/sandbox/types.js";
import { startWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import {
  captureWorktreeRunEndContext,
  retainWorktreeRunEndFailure,
  withWorktreeRunEnd,
} from "../../agents/worktrees/run-end-lifecycle.js";
import type { WorktreeWorkerAuthority } from "../../agents/worktrees/types.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { isAgentRunStaleLifecycleError } from "../../infra/agent-lifecycle-error.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { GitCommandTimeoutError } from "../../infra/git-exec.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { hasSqliteWorkerErrorCode } from "../../infra/sqlite-worker-error.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease-error.js";
import { withOpenClawStateLeasesWorkerAdmission } from "../../state/openclaw-state-lease-worker-owner.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  localWorkspaceDigestBytes,
  prepareLocalWorkspaceSourcePathSet,
} from "./local-workspace-cas.js";
import { withLocalWorkspaceLease } from "./local-workspace-lease.js";
import {
  localWorkspaceFingerprintPatch,
  readLocalWorkspaceCommit,
} from "./local-workspace-publication.js";
import type {
  LocalWorkspaceBaselineDocument,
  LocalWorkspaceManifestAction,
  LocalWorkspaceManifestMutation,
  LocalWorkspaceManifestValue,
  LocalWorkspaceMutation,
  LocalWorkspacePreparedUpdate,
  LocalWorkspaceProjection,
  LocalWorkspaceRejectedResult,
} from "./local-workspace-store.types.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

export type { LocalWorkspaceProjection } from "./local-workspace-store.types.js";

const compressMutation = promisify(zstdCompress);
const log = createSubsystemLogger("agents/worktrees");
const reconciliationContext = new AsyncLocalStorage<Record<string, string>>();
const shortDigest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

function reconciliationAbortReason(error: unknown) {
  const causes = collectNestedErrorCandidates(error);
  for (const cause of causes) {
    if (cause instanceof AcceptedWorkspacePublicationIndeterminateError) {
      return "publication-indeterminate";
    }
    if (cause instanceof OpenClawStateLeaseError) {
      return cause.loss ? (`lease-${cause.loss.reason}` as const) : cause.code;
    }
    for (const code of ["outcome-unknown", "closed", "overloaded", "unavailable"] as const) {
      if (hasSqliteWorkerErrorCode(cause, code)) {
        return `sqlite-${code}` as const;
      }
    }
    if (cause instanceof WorkerTaskError) {
      return `worker-${cause.code}` as const;
    }
    if (cause instanceof GitCommandTimeoutError) {
      return "git-timeout";
    }
    if (isAgentRunStaleLifecycleError(cause)) {
      return "stale-lifecycle";
    }
    const { stopReason } = resolveAgentRunErrorLifecycleFields(cause, undefined);
    if (stopReason) {
      return stopReason;
    }
  }
  return causes.some(isAbortError) ? "cancelled" : "operation-failed";
}

export async function withLocalWorkspaceReconciliation<T extends { conflictPaths: string[] }>(
  input: {
    worktreeId: string;
    pendingRef: string;
    baseCommit: string | null;
    targetCommit: string | null;
    target: "canonical" | "projection";
    reason: LocalWorkspacePauseReason;
  },
  run: (markPhase: (phase: LocalWorkspacePausePhase) => void) => Promise<T>,
): Promise<T> {
  const correlation = {
    workspace: shortDigest(input.worktreeId),
    plan: shortDigest(input.pendingRef),
    attempt: randomUUID(),
    baseCommit: input.baseCommit?.slice(0, 12) ?? "-",
    targetCommit: input.targetCommit?.slice(0, 12) ?? "-",
    target: input.target,
    reason: input.reason,
  };
  return reconciliationContext.run(correlation, async () => {
    const fields = JSON.stringify(correlation);
    const started = performance.now();
    let applied = false;
    let outcome = "aborted";
    let phase: LocalWorkspacePausePhase = "operation";
    let abortReason: ReturnType<typeof reconciliationAbortReason> | undefined;
    log.info(`Local workspace reconcile start: correlation=${fields}`);
    try {
      const result = await run((next) => {
        phase = next;
        applied ||= next === "apply";
      });
      outcome = result.conflictPaths.length ? "conflict" : applied ? "applied" : "replayed";
      return result;
    } catch (error) {
      abortReason = reconciliationAbortReason(error);
      throw error;
    } finally {
      log.info(
        `Local workspace reconcile finish: correlation=${fields} outcome=${outcome} durationMs=${(performance.now() - started).toFixed(1)}${abortReason ? ` abortReason=${abortReason} phase=${phase}` : ""}`,
      );
    }
  });
}

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
  /** Custody-owned row; projection callers separately check their selected session/worktree owner. */
  get: () => LocalWorkspaceProjection | undefined;
  manifest: (
    row: LocalWorkspaceProjection,
    action: LocalWorkspaceManifestAction,
  ) => Promise<LocalWorkspaceManifestValue>;
  create: (
    row: Omit<LocalWorkspaceProjection, "revision" | "rejectedResult">,
    authority?: WorktreeWorkerAuthority,
  ) => Promise<LocalWorkspaceProjection>;
  update: (
    row: LocalWorkspaceProjection,
    patch: Extract<LocalWorkspaceMutation, { kind: "update" }>["patch"],
    authority?: WorktreeWorkerAuthority,
    manifest?: LocalWorkspaceManifestMutation | LocalWorkspaceBaselineDocument,
    publicationPack?: Uint8Array<ArrayBuffer>,
  ) => Promise<LocalWorkspaceProjection>;
  accept: (
    prepared: LocalWorkspacePreparedUpdate,
    authority?: WorktreeWorkerAuthority,
  ) => Promise<LocalWorkspaceProjection>;
  delete: (row: LocalWorkspaceProjection, authority?: WorktreeWorkerAuthority) => Promise<void>;
  reject: (
    row: LocalWorkspaceProjection,
    rejection: Omit<LocalWorkspaceRejectedResult, "ref">,
    authority?: WorktreeWorkerAuthority,
  ) => Promise<LocalWorkspaceProjection>;
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
  return withWorktreeRunEnd(env, () => {
    const finishWait = startWorktreePreparationPhase("workspaceWait");
    return withLocalWorkspaceLease(
      {
        worktreeId: params.worktreeId,
        signal: params.signal,
      },
      context,
      (lease) => {
        finishWait();
        const leases = [...(inherited?.leases ?? []), lease];
        return withOpenClawStateLeasesWorkerAdmission(leases, context, async (authority) => {
          let active = true;
          let row: LocalWorkspaceProjection | undefined;
          const assertOwner = params.workerAuthority
            ? params.workerAuthority.assertCurrent
            : params.assertCurrent;
          const assertCustody = () => {
            captured.admission.assertCurrent();
            authority.assertCurrent();
            if (!active) {
              throw new Error("Local workspace custody has ended");
            }
          };
          const assertHost = () => {
            assertCustody();
            assertOwner?.();
          };
          const assertCurrent = () => {
            assertHost();
            if (params.assertCurrent !== assertOwner) {
              params.assertCurrent?.();
            }
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
                row =
                  reply?.type === "localWorkspace.get" && reply.row
                    ? Object.freeze(reply.row)
                    : undefined;
                const pruneLegacy = async () => {
                  if (!row?.tree_root_digest) {
                    return;
                  }
                  // Resume retirement after a crash between root publication and row cleanup.
                  let more: boolean;
                  do {
                    assertCurrent();
                    more = await runOpenClawStateWorkerOperation(
                      context,
                      (scope) =>
                        scope.execute({
                          type: "localWorkspace.pruneLegacy",
                          input: { id: params.worktreeId },
                        }),
                      { assertCurrent },
                    );
                  } while (more);
                };
                await pruneLegacy();
                // Observations may commit while a scan still owns unaccepted packs.
                let preparationEpoch: number | undefined;
                const prepare = async (preparations: readonly Uint8Array[]) => {
                  for (const preparation of preparations) {
                    assertCurrent();
                    const epoch = await runOpenClawStateWorkerOperation(
                      context,
                      (scope) =>
                        scope.execute({
                          type: "localWorkspace.prepare",
                          input: { preparation },
                        }),
                      { assertCurrent },
                    );
                    preparationEpoch = Math.min(preparationEpoch ?? epoch, epoch);
                  }
                  assertCurrent();
                };
                const mutate = async (
                  mutation: LocalWorkspaceMutation,
                  guard: WorktreeWorkerAuthority = params.workerAuthority ?? {},
                  preparedMutation?: Uint8Array,
                  publicationPack?: Uint8Array<ArrayBuffer>,
                ) => {
                  assertCurrent();
                  if (mutation.kind === "update" && mutation.manifest) {
                    // Checkpoints also carry recovery documents; the writer only publishes roots.
                    const {
                      previousRoot,
                      resultingRoot,
                      treeRoot,
                      fingerprints,
                      fingerprintsFromCheckpoint,
                    } = mutation.manifest;
                    mutation.manifest = {
                      previousRoot,
                      resultingRoot,
                      treeRoot,
                      fingerprints,
                      fingerprintsFromCheckpoint,
                      records: [],
                      removed: [],
                    };
                  }
                  let wireMutation: LocalWorkspaceMutation | Uint8Array | undefined =
                    preparedMutation ?? mutation;
                  const source =
                    mutation.kind === "create"
                      ? mutation.row
                      : mutation.kind === "update"
                        ? mutation.patch
                        : undefined;
                  if (!preparedMutation && typeof source?.source_paths_json === "string") {
                    const paths = prepareLocalWorkspaceSourcePathSet(source.source_paths_json);
                    await prepare([deflateRawSync(serialize({ paths }))]);
                    source.source_paths_digest = localWorkspaceDigestBytes(paths.digest);
                    // The writer stores this placeholder; host publication keeps the admitted JSON.
                    if (mutation.kind === "create") {
                      wireMutation = {
                        ...mutation,
                        row: { ...mutation.row, source_paths_json: "[]" },
                      };
                    } else if (mutation.kind === "update") {
                      wireMutation = {
                        ...mutation,
                        patch: { ...mutation.patch, source_paths_json: "[]" },
                      };
                    }
                  }
                  if (
                    !(wireMutation instanceof Uint8Array) &&
                    wireMutation.kind === "update" &&
                    wireMutation.manifest?.fingerprintsFromCheckpoint
                  ) {
                    wireMutation = {
                      ...wireMutation,
                      manifest: { ...wireMutation.manifest, fingerprints: undefined },
                    };
                  }
                  if (
                    publicationPack &&
                    !(wireMutation instanceof Uint8Array) &&
                    wireMutation.kind === "update"
                  ) {
                    wireMutation = {
                      ...wireMutation,
                      patch: { ...wireMutation.patch, journal_pack: undefined },
                    };
                  }
                  // Commit receipts and acknowledgement reuse the same decoded fingerprint bytes.
                  let pending:
                    | {
                        mutation: LocalWorkspaceMutation;
                        previous: LocalWorkspaceProjection | undefined;
                      }
                    | undefined = {
                    mutation:
                      mutation.kind === "update" && mutation.manifest?.fingerprints
                        ? {
                            ...mutation,
                            patch: {
                              ...mutation.patch,
                              ...localWorkspaceFingerprintPatch(mutation.manifest.fingerprints),
                            },
                          }
                        : mutation,
                    previous: row,
                  };
                  // Projection owns mutation bytes through settlement; authority is captured separately.
                  const predicates = structuredClone(guard.predicates);
                  // Reconcile checkpoints can retain MB of inputs below the broker queue limit.
                  let serializedBytes = preparedMutation?.byteLength ?? 0;
                  if (!preparedMutation) {
                    const serialized = serialize(wireMutation);
                    serializedBytes = serialized.byteLength;
                    const compressed =
                      serialized.byteLength > 1024 * 1024
                        ? await compressMutation(serialized, {
                            params: { [constants.ZSTD_c_compressionLevel]: 1 },
                          })
                        : undefined;
                    if (compressed && compressed.byteLength < serialized.byteLength) {
                      wireMutation = compressed;
                    }
                  }
                  const diagnostic = {
                    serializedBytes: serializedBytes + (publicationPack?.byteLength ?? 0),
                    wireBytes:
                      (wireMutation instanceof Uint8Array
                        ? wireMutation.byteLength
                        : serializedBytes) + (publicationPack?.byteLength ?? 0),
                    correlation: reconciliationContext.getStore() ?? {
                      workspace: shortDigest(params.worktreeId),
                      plan: row?.pending_ref ? shortDigest(row.pending_ref) : "-",
                      baseCommit: row?.base_commit.slice(0, 12) ?? "-",
                    },
                  };
                  let admission: SqliteWorkerOperationAdmission | undefined;
                  let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
                  const assertWrite = () => {
                    if (guard.assertCurrent !== assertHost) {
                      assertHost();
                    }
                    if (guard.assertCurrent !== assertOwner) {
                      guard.assertCurrent?.();
                    }
                  };
                  try {
                    const acknowledged = await withOpenClawStateLeasesWorkerAdmission(
                      leases,
                      context,
                      (write) =>
                        runOpenClawStateWorkerOperation(
                          context,
                          (scope) =>
                            scope.execute(
                              {
                                type: "localWorkspace.mutate",
                                input: {
                                  id: params.worktreeId,
                                  mutation: wireMutation!,
                                  diagnostic,
                                  preparationEpoch,
                                  predicates,
                                  workspaceEvidence: guard.workspaceEvidence,
                                  stateOwnerPath: guard.stateOwnerPath,
                                  leases: write.identities,
                                },
                              },
                              publicationPack
                                ? { transferredInput: { journalPack: publicationPack } }
                                : undefined,
                            ),
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
                                    pending!.mutation,
                                    pending!.previous,
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
                      pending!.mutation,
                      pending!.previous,
                    );
                    if (!pending!.previous?.tree_root_digest) {
                      await pruneLegacy();
                    }
                  } catch (error) {
                    const outcome = await settled;
                    if (outcome?.kind === "completed" && admission?.committed) {
                      try {
                        row = readLocalWorkspaceCommit(
                          admission.committed.facts,
                          params.worktreeId,
                          pending!.mutation,
                          pending!.previous,
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
                  } finally {
                    // A retained admission must not retain completed workspace payloads.
                    pending = undefined;
                    wireMutation = undefined;
                  }
                };
                const readManifest: LocalWorkspaceStore["manifest"] = async (previous, action) => {
                  assertCurrent();
                  if (previous.worktree_id !== params.worktreeId) {
                    throw new Error("Local workspace binding changed");
                  }
                  const value = await runGitWorkerOperation(
                    {
                      type: "workspace.manifest.local",
                      input: {
                        owner: JSON.stringify([
                          context.admission.coordinationKey,
                          params.worktreeId,
                        ]),
                      },
                    },
                    {
                      signal: lease.signal,
                      assertCurrent,
                      readWorkspaceManifest: async (knownTreeRoot, { signal }) => {
                        const result = await executeExistingOpenClawStateRead(
                          { path: context.admission.databasePath, env: context.environment },
                          {
                            type: "localWorkspace.manifest",
                            input: {
                              id: params.worktreeId,
                              revision: previous.revision,
                              action,
                              knownTreeRoot,
                            },
                          },
                          { context, current: true, live: true, signal },
                        );
                        assertCurrent();
                        if (!result) {
                          throw new Error("Local workspace manifest is unavailable");
                        }
                        return result.snapshot;
                      },
                    },
                  );
                  assertCurrent();
                  if (value.kind === "scan") {
                    await prepare(value.preparations ?? []);
                    const { preparations: _preparations, ...checkpoint } = value;
                    return checkpoint;
                  }
                  if (value.kind === "replace") {
                    await prepare(value.update.preparations ?? []);
                    value.update.preparations = undefined;
                  }
                  return value;
                };
                const accept: LocalWorkspaceStore["accept"] = async (prepared, guard) => {
                  await prepare(prepared.preparations ?? []);
                  await mutate(
                    {
                      kind: "update",
                      revision: prepared.revision,
                      patch: prepared.patch,
                      rejectedResult: prepared.rejectedResult,
                    },
                    guard,
                    prepared.mutation,
                  );
                  return row!;
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
                    assertCustody();
                    return row;
                  },
                  manifest: readManifest,
                  accept,
                  reject: async (previous, rejection, guard) => {
                    if (
                      previous.worktree_id !== params.worktreeId ||
                      !previous.pending_ref ||
                      previous.journal_json
                    ) {
                      throw new Error(
                        "Local workspace rejection requires an unapplied pending result",
                      );
                    }
                    await mutate(
                      {
                        kind: "update",
                        revision: previous.revision,
                        patch: {},
                        rejectedResult: { ref: previous.pending_ref, ...rejection },
                      },
                      guard,
                    );
                    return row!;
                  },
                  create: async (value, guard) => {
                    await mutate({ kind: "create", row: value }, guard);
                    return row!;
                  },
                  update: async (previous, patch, guard, manifest, publicationPack) => {
                    if (previous.worktree_id !== params.worktreeId) {
                      throw new Error("Local workspace binding changed");
                    }
                    if (manifest && "rawManifest" in manifest) {
                      using phases = observeDiagnosticsTimelinePhases(
                        "attempt.setup.sandbox.workspace_selection.baseline.prepare",
                      );
                      const prepared = await readManifest(previous, {
                        kind: "replace",
                        ...manifest,
                        patch,
                      });
                      if (prepared.kind !== "replace") {
                        throw new Error("Local workspace baseline preparation is missing");
                      }
                      phases.mark("attempt.setup.sandbox.workspace_selection.baseline.accept");
                      await accept(prepared.update, guard);
                    } else if (manifest && !manifest.treeRoot) {
                      const prepared = await readManifest(previous, {
                        kind: "prepare",
                        manifest,
                        patch,
                      });
                      if (prepared.kind !== "replace") {
                        throw new Error("Local workspace checkpoint preparation is missing");
                      }
                      await accept(prepared.update, guard);
                    } else {
                      await mutate(
                        { kind: "update", revision: previous.revision, patch, manifest },
                        guard,
                        undefined,
                        publicationPack,
                      );
                    }
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
            row = undefined;
          }
        });
      },
    ).finally(finishWait);
  });
}
