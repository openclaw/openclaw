import type { LocalWorkspacePauseReason } from "../../agents/sandbox/local-workspace-quiescence.js";
import type { SandboxConfig } from "../../agents/sandbox/types.js";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import {
  captureWorktreeRegistryReadGuard,
  prepareWorktreeRegistryGuard,
  readRegistryWorktree,
  readLiveRegistryWorktreeByPath,
} from "../../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import type {
  ManagedWorktreeRecord,
  WorktreeWorkerAuthority,
} from "../../agents/worktrees/types.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { isPathInside } from "../../infra/path-guards.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease-error.js";
import { localWorkspaceProjectionPath } from "./local-workspace-checkout.js";
import { removeLocalWorkspaceCheckpointCapture } from "./local-workspace-checkpoint.js";
import { finishLocalWorkspaceHandoff } from "./local-workspace-handoff.js";
import { assertLocalWorkspaceProjectionOwner } from "./local-workspace-owner-identity.js";
import { runLocalWorkspaceProjection } from "./local-workspace-projection-operation.js";
import { projectionOperations } from "./local-workspace-state.js";
import { withLocalWorkspaceStore, type LocalWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceCustody, LocalWorkspaceOwner } from "./local-workspace-types.js";

type PendingWorkspaceOperation<T> = { result: Promise<T>; signal?: AbortSignal };
const pendingCheckpoints = new Map<string, PendingWorkspaceOperation<void>>();
const pendingPreparations = new Map<string, PendingWorkspaceOperation<string>>();

/** Queued preparations share observation, while each caller retains its own run authority. */
export function withLocalWorkspacePreparation(
  owner: LocalWorkspaceOwner,
  options: { sandbox: SandboxConfig; acceleration: boolean; signal?: AbortSignal },
  prepare: (beginCapture: () => void) => Promise<string>,
): Promise<string> {
  return joinLocalWorkspaceOperation(
    pendingPreparations,
    owner,
    [owner.agentId, owner.sessionKey, owner.sessionId, owner.lifecycleRevision],
    prepare,
    options,
  );
}

async function joinLocalWorkspaceOperation<T>(
  pendingOperations: Map<string, PendingWorkspaceOperation<T>>,
  params: {
    worktree: ManagedWorktreeRecord;
    env?: NodeJS.ProcessEnv;
    assertCurrent?: () => void;
    workerAuthority?: WorktreeWorkerAuthority;
  },
  session: readonly [string, string, string, string | null] | undefined,
  run: (beginCapture: () => void) => Promise<T>,
  options: {
    sandbox?: SandboxConfig;
    acceleration?: boolean;
    signal?: AbortSignal;
    knownMutation?: true;
  } = {},
): Promise<T> {
  const context = captureWorktreeRunEndContext(params.env ?? process.env);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.signal?.throwIfAborted();
    params.assertCurrent?.();
    params.workerAuthority?.assertCurrent?.();
  };
  assertCurrent();
  const { worktree } = params;
  const key = JSON.stringify([
    context.admission.coordinationKey,
    worktree.id,
    worktree.path,
    worktree.repoRoot,
    worktree.ownerKind,
    worktree.ownerId,
    worktree.branch,
    worktree.snapshotRef,
    worktree.removedAt,
    session,
    options.sandbox,
    options.acceleration,
    options.knownMutation,
  ]);
  const pending = pendingOperations.get(key);
  let result: T;
  if (pending) {
    try {
      result = await timeWorktreePreparationPhase("workspaceWait", () =>
        racePromiseWithAbortSignal(pending.result, options.signal),
      );
    } catch (error) {
      assertCurrent();
      // Retry a stopped producer only after settlement, never an uncertain write
      // or storage failure that happened to coincide with its cancellation.
      if (
        pending.signal?.aborted &&
        (error === pending.signal.reason ||
          (error instanceof OpenClawStateLeaseError &&
            error.code === "OPENCLAW_STATE_LEASE_ABORTED" &&
            error.cause === pending.signal.reason))
      ) {
        return joinLocalWorkspaceOperation(pendingOperations, params, session, run, options);
      }
      throw error;
    }
  } else {
    const forget = () => {
      if (pendingOperations.get(key)?.result === resultPromise) {
        pendingOperations.delete(key);
      }
    };
    // Guest writes do not advance a database generation. Requests arriving after
    // capture starts need their own observation, even while this one is in flight.
    const resultPromise = run(forget).finally(forget);
    pendingOperations.set(key, { result: resultPromise, signal: options.signal });
    result = await resultPromise;
  }
  assertCurrent();
  return result;
}

/** Checkpoint callers keep their own session authority while sharing queued capture. */
export function checkpointLocalWorkspace(
  owner: LocalWorkspaceOwner,
  options: { knownMutation?: true } = {},
): Promise<void> {
  return joinLocalWorkspaceOperation(
    pendingCheckpoints,
    owner,
    [owner.agentId, owner.sessionKey, owner.sessionId, owner.lifecycleRevision],
    (beginCapture) =>
      withLocalWorkspaceStore({ ...owner, worktreeId: owner.worktree.id }, async (store) => {
        beginCapture();
        let snapshotCapture = false;
        if (
          !options.knownMutation &&
          (await probeUnchangedLocalWorkspace(owner, store, ["canonical"], (entries, elapsedMs) => {
            // A probe stops at its first edit. The accepted inventory also covers
            // large trees whose changed file happens to sort first.
            snapshotCapture = entries >= 20_000 || elapsedMs >= 500;
          }))
        ) {
          await removeLocalWorkspaceCheckpointCapture(store.get()!.projection_path, {
            signal: store.signal,
            commitGuard: store.assertCurrent,
          });
          return;
        }
        await runLocalWorkspaceProjection(
          owner,
          store,
          (state, quiescence, capture) =>
            state.synchronize("canonical", {
              captureRejected: true,
              capture,
              afterCapture:
                quiescence &&
                (() => timeWorktreePreparationPhase("runtimeResume", quiescence.resume)),
            }),
          { reason: "checkpoint", snapshotCapture },
        );
      }),
    options,
  );
}

/** Publication and lifecycle callers retain their own authority while joining local settlement. */
export async function withSettledLocalWorkspace<T>(
  params: {
    worktree: ManagedWorktreeRecord;
    env?: NodeJS.ProcessEnv;
    assertCurrent?: () => void;
    workerAuthority?: WorktreeWorkerAuthority;
    retireRuntime?: boolean;
    restoreSnapshot?: boolean;
    finishRestore?: boolean;
    sessionOwner?: Pick<
      LocalWorkspaceOwner,
      "agentId" | "sessionKey" | "sessionId" | "lifecycleRevision"
    >;
  },
  operation: (custody?: LocalWorkspaceCustody) => Promise<T>,
): Promise<T> {
  return await settleLocalWorkspace(params, operation);
}

async function settleLocalWorkspace<T>(
  params: Parameters<typeof withSettledLocalWorkspace>[0],
  operation: (custody?: LocalWorkspaceCustody) => Promise<T>,
): Promise<T> {
  const context = captureWorktreeRunEndContext(params.env ?? process.env);
  const env = { ...(params.env ?? process.env), ...context.environment };
  const persistentRetirements: Array<{ finish: () => Promise<void> }> = [];
  if (params.retireRuntime) {
    // Stream finalization checkpoints acquire the projection lease themselves.
    // Settle them before taking that lease; its quiescence owner rechecks custody below.
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env },
      { type: "localWorkspace.get", input: { id: params.worktree.id } },
      { context, current: true, live: true },
    );
    context.admission.assertCurrent();
    params.assertCurrent?.();
    if (reply && (!reply.ok || reply.type !== "localWorkspace.get")) {
      throw new Error("Unexpected local workspace retirement lookup");
    }
    if (reply?.row) {
      if (params.sessionOwner) {
        const expectedOwner: LocalWorkspaceOwner = {
          ...params.sessionOwner,
          // The existing same-id reset repair below owns lifecycle-revision adoption.
          lifecycleRevision: reply.row.lifecycle_revision,
          worktree: params.worktree,
          env,
          assertCurrent: params.assertCurrent ?? (() => {}),
        };
        assertLocalWorkspaceProjectionOwner(
          reply.row,
          expectedOwner,
          localWorkspaceProjectionPath(expectedOwner),
        );
      }
      const { readRegistry } = await import("../../agents/sandbox/registry.js");
      const { prepareSandboxPersistentExecRetirement } =
        await import("../../agents/sandbox/persistent-exec-retirement.js");
      for (const runtime of (await readRegistry({ path: context.admission.databasePath, env }))
        .entries) {
        if (runtime.workspaceDir === reply.row.projection_path) {
          persistentRetirements.push(
            await prepareSandboxPersistentExecRetirement({
              containerName: runtime.containerName,
              env,
              assertCurrent: () => {
                context.admission.assertCurrent();
                params.assertCurrent?.();
                params.workerAuthority?.assertCurrent?.();
              },
            }),
          );
        }
      }
    }
  }
  return await withLocalWorkspaceStore(
    { ...params, env, worktreeId: params.worktree.id },
    async (store) => {
      store.assertCurrent();
      const row = store.get();
      if (!row) {
        return await operation({
          worktreeId: params.worktree.id,
          assertCurrent: store.assertCurrent,
          workerAuthority: store.workerAuthority,
        });
      }
      const worktree = params.worktree;
      const workerAuthority: WorktreeWorkerAuthority = {
        ...params.workerAuthority,
        assertCurrent: params.workerAuthority
          ? params.workerAuthority.assertCurrent
          : params.assertCurrent,
        predicates: [
          ...(params.workerAuthority?.predicates ?? []),
          {
            kind: "projection",
            id: worktree.id,
            ownerId: row.session_key,
            path: worktree.path,
            repoRoot: worktree.repoRoot,
          },
        ],
      };
      const assertWorktreeCurrent = await prepareWorktreeRegistryGuard(context, workerAuthority);
      const owner: LocalWorkspaceOwner = {
        worktree,
        env,
        agentId: params.sessionOwner?.agentId ?? row.agent_id,
        sessionKey: params.sessionOwner?.sessionKey ?? row.session_key,
        sessionId: params.sessionOwner?.sessionId ?? row.session_id,
        lifecycleRevision: params.sessionOwner
          ? params.sessionOwner.lifecycleRevision
          : row.lifecycle_revision,
        workerAuthority,
        assertCurrent: () => {
          if (params.assertCurrent !== workerAuthority.assertCurrent) {
            params.assertCurrent?.();
          }
          assertWorktreeCurrent();
        },
      };
      return await runLocalWorkspaceProjection(
        owner,
        store,
        async (state, quiescence) => {
          if (params.finishRestore) {
            await state.finishRestore();
          } else if (params.restoreSnapshot) {
            await state.restoreSnapshot();
          } else if (state.current().baseline_ref) {
            await state.synchronize("canonical");
            // Archive one accepted namespace, including canonical edits and deletions.
            if (params.retireRuntime) {
              await state.synchronize("projection");
            }
          }
          if (params.retireRuntime) {
            for (const retirement of persistentRetirements) {
              await retirement.finish();
            }
            await quiescence?.retire();
          }
          const current = state.current();
          return await operation(
            current.baseline_ref
              ? {
                  worktreeId: worktree.id,
                  projectionPath: current.projection_path,
                  projectionRevision: current.revision,
                  prepareArchive: state.prepareArchive,
                  canonicalPaths: state.canonicalPaths,
                  synchronizeProjection: () => state.synchronize("projection"),
                  assertCurrent: state.current,
                  workerAuthority: state.workerAuthority,
                }
              : {
                  worktreeId: worktree.id,
                  projectionRevision: current.revision,
                  assertCurrent: store.assertCurrent,
                  workerAuthority: store.workerAuthority,
                },
          );
        },
        {
          reason: params.retireRuntime
            ? "retirement"
            : params.restoreSnapshot || params.finishRestore
              ? "restore"
              : "publication",
        },
      );
    },
  );
}

export async function withSettledLocalWorkspacePath<T>(
  params: { cwd: string; assertCurrent?: () => void },
  operation: (custody?: LocalWorkspaceCustody) => Promise<T>,
): Promise<T> {
  const context = captureWorktreeRunEndContext(process.env);
  const env = { ...process.env, ...context.environment };
  const record = await readLiveRegistryWorktreeByPath(context, params.cwd);
  params.assertCurrent?.();
  return record
    ? await withSettledLocalWorkspace(
        { worktree: record, env, assertCurrent: params.assertCurrent },
        operation,
      )
    : await operation();
}

/** An unchanged turn needs no filesystem effects and can leave its runtimes running. */
export function reuseLocalWorkspaceProjection(
  owner: LocalWorkspaceOwner,
  signal?: AbortSignal,
  beginCapture?: () => void,
) {
  return withLocalWorkspaceStore(
    { ...owner, worktreeId: owner.worktree.id, signal },
    async (store) => {
      using phases = observeDiagnosticsTimelinePhases(
        "attempt.setup.sandbox.workspace_selection.reuse.reconcile",
      );
      try {
        if (store.get()?.baseline_ref) {
          beginCapture?.();
        }
        return (
          (await probeUnchangedLocalWorkspace(owner, store, ["canonical", "projection"])) ??
          (await runLocalWorkspaceProjection(owner, store, (state) => state.reuse(), {
            reason: "preparation",
          }))
        );
      } finally {
        phases.mark("attempt.setup.sandbox.workspace_selection.reuse.release");
      }
    },
  );
}

/** A live probe can prove there is nothing to publish; changed bytes still require quiescence. */
async function probeUnchangedLocalWorkspace(
  owner: LocalWorkspaceOwner,
  store: LocalWorkspaceStore,
  targets: readonly ("canonical" | "projection")[],
  observeProbe?: (entries: number, elapsedMs: number) => void,
) {
  let row = store.get();
  if (
    !row?.baseline_ref ||
    !row.tree_root_digest ||
    row.session_id !== owner.sessionId ||
    row.lifecycle_revision !== owner.lifecycleRevision ||
    row.pending_ref ||
    row.journal_json ||
    row.paused_runtimes_json
  ) {
    return undefined;
  }
  // Bind the row before observation; acceptance retains the same lease and live authority.
  projectionOperations(owner, store, row).current();
  for (const target of targets) {
    const selected = row;
    const started = performance.now();
    const snapshot = await timeWorktreePreparationPhase(
      target === "canonical" ? "synchronizeCanonical" : "synchronizeProjection",
      async () => {
        try {
          return await store.manifest(selected, {
            kind: "probe",
            target,
            canonicalRoot: owner.worktree.path,
          });
        } catch {
          // Live writers can interrupt discovery; retry under the existing pause owner.
          store.signal.throwIfAborted();
          store.assertCurrent();
          return undefined;
        }
      },
    );
    observeProbe?.(
      snapshot?.kind === "rescan" ? (snapshot.entryCount ?? 0) : 0,
      performance.now() - started,
    );
    store.assertCurrent();
    if (snapshot?.kind !== "scan" || snapshot.resultingRoot !== snapshot.previousRoot) {
      return undefined;
    }
    // Acceptance failures must propagate, never retry an uncertain write.
    if (snapshot.observation) {
      row = await store.accept(snapshot.observation, owner.workerAuthority);
    }
  }
  return row.projection_path;
}

/** Every operation owns the same renewable, cross-process reconciliation lease. */
export async function withLocalWorkspaceProjection<T>(
  owner: LocalWorkspaceOwner,
  run: Parameters<typeof runLocalWorkspaceProjection<T>>[2],
  options: { provision?: boolean; signal?: AbortSignal; reason?: LocalWorkspacePauseReason } = {},
) {
  return await withLocalWorkspaceStore(
    { ...owner, worktreeId: owner.worktree.id, signal: options.signal },
    (store) => runLocalWorkspaceProjection(owner, store, run, options),
  );
}

/** Expiry belongs to the existing worktree retention owner, never sandbox pruning. */
export async function expireLocalWorkspaceProjection(params: {
  worktree: ManagedWorktreeRecord;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  retireSnapshot?: (assertCurrent: () => void) => Promise<void>;
  workerAuthority?: WorktreeWorkerAuthority;
}) {
  const context = captureWorktreeRunEndContext(params.env);
  const env = { ...params.env, ...context.environment };
  return await withLocalWorkspaceStore(
    { ...params, env, worktreeId: params.worktree.id },
    async (store) => {
      store.assertCurrent();
      const row = store.get();
      if (!row) {
        await params.retireSnapshot?.(store.assertCurrent);
        return;
      }
      if (params.worktree.removedAt === undefined) {
        throw new Error("Cannot expire a live sandbox workspace");
      }
      const accept = captureWorktreeRegistryReadGuard(context, "lifecycle");
      const record = await readRegistryWorktree(context, params.worktree.id);
      const assertWorktreeCurrent = accept(record);
      params.assertCurrent();
      if (record?.removedAt !== params.worktree.removedAt || record?.ownerId !== row.session_key) {
        throw new Error("Workspace retention owner changed");
      }
      const owner: LocalWorkspaceOwner = {
        worktree: params.worktree,
        env,
        agentId: row.agent_id,
        sessionKey: row.session_key,
        sessionId: row.session_id,
        lifecycleRevision: row.lifecycle_revision,
        workerAuthority: params.workerAuthority,
        assertCurrent: () => {
          if (params.workerAuthority?.assertCurrent !== params.assertCurrent) {
            params.workerAuthority?.assertCurrent?.();
          }
          params.assertCurrent();
          assertWorktreeCurrent();
        },
      };
      await runLocalWorkspaceProjection(owner, store, (state) =>
        state.expire(params.retireSnapshot),
      );
    },
  );
}

/** Bind only a live session-owned managed checkout, never an arbitrary host path. */
export async function resolveLocalWorkspaceOwner(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir?: string;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<(LocalWorkspaceOwner & Disposable) | undefined> {
  const context = captureWorktreeRunEndContext(params.env ?? process.env);
  const env = { ...(params.env ?? process.env), ...context.environment };
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath:
      params.storePath ??
      resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.agentId,
        env,
      }),
    env,
  };
  const lifetime = new DisposableStack();
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let unregister = () => {};
  lifetime.defer(() => {
    retained?.release();
    unregister();
  });
  const release = () => lifetime.dispose();
  const assertActive = () => {
    params.assertCurrent?.();
    if (lifetime.disposed) {
      throw new Error("Local sandbox workspace authority changed");
    }
  };
  const metadata = captureSessionEntryMetadataRead(scope, assertActive);
  try {
    let databaseIdentity: string | undefined;
    const entry = metadata
      ? metadata.readCurrent()
      : await withSessionEntryReadOnlyInWorker(
          scope,
          assertActive,
          async (read) => {
            if (!read.ok) {
              throw read.error;
            }
            const preparedEntry = read.value;
            if (databaseIdentity && preparedEntry) {
              retained = retainPreparedSessionEntryPredicate({
                databaseIdentity,
                sessionKey: scope.sessionKey,
                entry: preparedEntry,
                matches: (before, after) =>
                  after !== undefined &&
                  before?.sessionId === after.sessionId &&
                  before?.lifecycleRevision === after.lifecycleRevision &&
                  after.archivedAt === undefined &&
                  before?.worktree?.id === after.worktree?.id,
              });
            }
            return preparedEntry;
          },
          (database, identity) => {
            databaseIdentity = identity.key;
            unregister = registerOpenClawAgentDatabaseAsyncResource({
              agentId: database.agentId,
              path: database.path,
              revoke: release,
              close: async () => release(),
            });
          },
        );
    if (!entry?.worktree?.id) {
      release();
      return undefined;
    }
    const accept = captureWorktreeRegistryReadGuard(context, "lifecycle");
    const worktree = await readRegistryWorktree(context, entry.worktree.id);
    const assertWorktreeCurrent = accept(worktree);
    if (
      !worktree ||
      worktree.removedAt !== undefined ||
      worktree.ownerKind !== "session" ||
      worktree.ownerId !== params.sessionKey ||
      worktree.repoRoot !== entry.worktree.repoRoot ||
      worktree.branch !== entry.worktree.branch ||
      (params.workspaceDir && !isPathInside(worktree.path, params.workspaceDir))
    ) {
      throw new Error("Local sandbox managed workspace owner changed");
    }
    const assertSessionCurrent = () => {
      if (!metadata) {
        assertActive();
        if (!retained?.isCurrent()) {
          throw new Error("Local sandbox workspace authority changed");
        }
        return;
      }
      const now = metadata.readCurrent();
      if (
        now?.sessionId !== entry.sessionId ||
        now?.lifecycleRevision !== entry.lifecycleRevision ||
        now?.archivedAt !== undefined ||
        now?.worktree?.id !== worktree.id
      ) {
        throw new Error("Local sandbox workspace authority changed");
      }
    };
    const assertCurrent = () => {
      assertSessionCurrent();
      assertWorktreeCurrent();
    };
    assertCurrent();
    const owner: LocalWorkspaceOwner & Disposable = {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision ?? null,
      worktree,
      assertCurrent,
      workerAuthority: {
        assertCurrent: assertSessionCurrent,
        predicates: [{ kind: "live-binding", record: worktree }],
      },
      env,
      [Symbol.dispose]: release,
    };
    if (entry.localWorkspaceHandoff) {
      const handoff = entry.localWorkspaceHandoff;
      await finishLocalWorkspaceHandoff(owner, handoff);
      await patchSessionEntryCore(scope, (current) => {
        assertCurrent();
        if (
          current?.sessionId !== owner.sessionId ||
          current.lifecycleRevision !== entry.lifecycleRevision ||
          JSON.stringify(current.localWorkspaceHandoff) !== JSON.stringify(handoff)
        ) {
          throw new Error("Local workspace handoff changed before completion");
        }
        return { localWorkspaceHandoff: undefined };
      });
    }
    return owner;
  } catch (error) {
    release();
    throw error;
  }
}
