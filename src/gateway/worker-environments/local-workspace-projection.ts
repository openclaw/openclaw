import path from "node:path";
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
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { projectionOperations } from "./local-workspace-state.js";
import { withLocalWorkspaceStore, type LocalWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { OVERSIZED_WORKSPACE_FILE_ERROR_PREFIX } from "./workspace-manifest-comparison.js";
import { isLocalWorkspaceBaseRefreshRef } from "./workspace-result-inventory.js";

type LocalWorkspaceCustody = {
  worktreeId: string;
  projectionPath?: string;
  prepareArchive?: (snapshot: string) => Promise<void>;
  canonicalPaths?: () => Promise<Set<string>>;
  assertCurrent: () => void;
  workerAuthority: WorktreeWorkerAuthority;
};

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
  },
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
        agentId: row.agent_id,
        sessionKey: row.session_key,
        sessionId: row.session_id,
        lifecycleRevision: row.lifecycle_revision,
        workerAuthority,
        assertCurrent: () => {
          params.assertCurrent?.();
          assertWorktreeCurrent();
        },
      };
      return await runLocalWorkspaceProjection(owner, store, async (state, quiescence) => {
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
                prepareArchive: state.prepareArchive,
                canonicalPaths: state.canonicalPaths,
                assertCurrent: state.current,
                workerAuthority: state.workerAuthority,
              }
            : {
                worktreeId: worktree.id,
                assertCurrent: store.assertCurrent,
                workerAuthority: store.workerAuthority,
              },
        );
      });
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

/** Every operation owns the same renewable, cross-process reconciliation lease. */
export async function withLocalWorkspaceProjection<T>(
  owner: LocalWorkspaceOwner,
  run: (
    state: ReturnType<typeof projectionOperations>,
    quiescence?: Awaited<
      ReturnType<
        typeof import("../../agents/sandbox/local-workspace-quiescence.js").quiesceLocalWorkspace
      >
    >,
  ) => Promise<T>,
  options: { provision?: boolean; signal?: AbortSignal } = {},
) {
  return await withLocalWorkspaceStore(
    { ...owner, worktreeId: owner.worktree.id, signal: options.signal },
    (store) => runLocalWorkspaceProjection(owner, store, run, options),
  );
}

async function runLocalWorkspaceProjection<T>(
  owner: LocalWorkspaceOwner,
  store: LocalWorkspaceStore,
  run: Parameters<typeof withLocalWorkspaceProjection<T>>[1],
  options: { provision?: boolean } = {},
) {
  const assertCurrent = () => {
    store.assertCurrent();
    owner.assertCurrent();
  };
  assertCurrent();
  const workerAuthority: WorktreeWorkerAuthority = {
    ...store.workerAuthority,
    predicates: owner.workerAuthority?.predicates ?? store.workerAuthority.predicates,
  };
  let previous = store.get();
  // A reset may recover its prior result; another session incarnation cannot adopt it.
  if (
    previous &&
    previous.session_id === owner.sessionId &&
    previous.session_key === owner.sessionKey &&
    previous.agent_id === owner.agentId &&
    previous.lifecycle_revision !== owner.lifecycleRevision
  ) {
    previous = await store.update(
      previous,
      { lifecycle_revision: owner.lifecycleRevision },
      workerAuthority,
    );
  }
  const operations = projectionOperations(
    { ...owner, assertCurrent, workerAuthority },
    store,
    previous,
  );
  const { quiesceLocalWorkspace, parseLocalWorkspacePausedRuntimes } =
    await import("../../agents/sandbox/local-workspace-quiescence.js");
  const quiescence =
    previous && !options.provision
      ? await timeWorktreePreparationPhase("runtimeQuiesce", () =>
          quiesceLocalWorkspace({
            env: owner.env,
            workspaceDir: previous.projection_path,
            retained: parseLocalWorkspacePausedRuntimes(previous.paused_runtimes_json),
            persist: (runtimes) =>
              operations.rememberPaused(runtimes.length ? JSON.stringify(runtimes) : null),
            assertCurrent,
          }),
        )
      : undefined;
  try {
    return await run(operations, quiescence);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(OVERSIZED_WORKSPACE_FILE_ERROR_PREFIX)) {
      const { describeLocalWorkspaceRecovery } = await import("./local-workspace-recovery.js");
      throw await describeLocalWorkspaceRecovery(error, owner, operations);
    }
    throw error;
  } finally {
    // Retirement finished cleanup before removal could invalidate the old binding.
    // Otherwise, only acknowledged journal changes allow the frozen guest to resume.
    const retained = quiescence?.retired ? undefined : store.get();
    if (
      retained &&
      !retained.journal_json &&
      !(retained.pending_target && isLocalWorkspaceBaseRefreshRef(retained.pending_ref))
    ) {
      if (quiescence) {
        await timeWorktreePreparationPhase("runtimeResume", () => quiescence.resume());
      }
    }
  }
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

/** Retain the exact workspace selection, including the producer's native spawn receipt. */
async function retainLocalWorkspaceSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  env: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}) {
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: resolveSessionStorePathCore(params.cfg.session?.store, params),
    env: params.env,
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
  const matches = (before: SessionEntry | undefined, after: SessionEntry | undefined) =>
    after !== undefined &&
    before?.sessionId === after.sessionId &&
    before?.lifecycleRevision === after.lifecycleRevision &&
    after.archivedAt === undefined &&
    before?.worktree?.id === after.worktree?.id &&
    before?.worktree?.branch === after.worktree?.branch &&
    before?.worktree?.repoRoot === after.worktree?.repoRoot &&
    before?.spawnedBy === after.spawnedBy &&
    before?.spawnedBySessionId === after.spawnedBySessionId &&
    before?.parentSessionLifecycleRevision === after.parentSessionLifecycleRevision &&
    before?.inheritedWorktreeId === after.inheritedWorktreeId &&
    before?.spawnedWorkspaceDir === after.spawnedWorkspaceDir &&
    before?.spawnedCwd === after.spawnedCwd;
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
                matches,
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
    // Retained predicates observe later publications; admission must also reject an archived snapshot.
    if (entry?.archivedAt !== undefined) {
      throw new Error("Local sandbox workspace authority changed");
    }
    return {
      entry,
      assertCurrent: () => {
        assertActive();
        if (metadata ? !matches(entry, metadata.readCurrent()) : !retained?.isCurrent()) {
          throw new Error("Local sandbox workspace authority changed");
        }
      },
      [Symbol.dispose]: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Resolve admitted project access; publication and cleanup keep direct ownership by default. */
export async function resolveLocalWorkspaceOwner(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir?: string;
  inheritWorkspace?: boolean;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<
  | (LocalWorkspaceOwner &
      Disposable & {
        workspaceRelativePath: string;
        sourceSessionKeys: readonly string[];
      })
  | undefined
> {
  const context = captureWorktreeRunEndContext(params.env ?? process.env);
  const env = { ...(params.env ?? process.env), ...context.environment };
  const lifetime = new DisposableStack();
  const sessions: Array<Awaited<ReturnType<typeof retainLocalWorkspaceSession>>> = [];
  const assertSessionsCurrent = () => {
    params.assertCurrent?.();
    if (lifetime.disposed) {
      throw new Error("Local sandbox workspace authority changed");
    }
    for (const session of sessions) {
      session.assertCurrent();
    }
  };
  try {
    let sessionKey = params.sessionKey;
    let expectedParent: { sessionId: string; lifecycleRevision: string | undefined } | undefined;
    const visited = new Set<string>();
    const sourceSessionKeys: string[] = [];
    let inheritedWorktreeId: string | undefined;
    const inheritedSelections: Array<{ workspaceDir: string; cwd?: string }> = [];
    while (true) {
      if (visited.has(sessionKey)) {
        throw new Error("Local sandbox workspace lineage changed");
      }
      visited.add(sessionKey);
      const session = lifetime.use(
        await retainLocalWorkspaceSession({ ...params, env, sessionKey }),
      );
      const entry = session.entry;
      if (!entry) {
        if (expectedParent) {
          throw new Error("Local sandbox workspace parent changed");
        }
        lifetime.dispose();
        return undefined;
      }
      sessions.push(session);
      assertSessionsCurrent();
      if (
        expectedParent &&
        (entry.sessionId !== expectedParent.sessionId ||
          entry.lifecycleRevision !== expectedParent.lifecycleRevision)
      ) {
        throw new Error("Local sandbox workspace parent changed");
      }
      if (!entry.worktree?.id) {
        // Old helpers keep their private workspace; a path or lineage alone is not admission.
        if (!params.inheritWorkspace || !entry.inheritedWorktreeId) {
          if (inheritedWorktreeId) {
            throw new Error("Local sandbox inherited workspace binding changed");
          }
          lifetime.dispose();
          return undefined;
        }
        if (
          (inheritedWorktreeId && entry.inheritedWorktreeId !== inheritedWorktreeId) ||
          !isSubagentSessionKey(sessionKey) ||
          !entry.spawnedBy ||
          parseAgentSessionKey(entry.spawnedBy)?.agentId !== params.agentId ||
          !entry.spawnedBySessionId ||
          !entry.spawnedWorkspaceDir
        ) {
          throw new Error("Local sandbox inherited workspace binding changed");
        }
        inheritedWorktreeId = entry.inheritedWorktreeId;
        inheritedSelections.push({
          workspaceDir: entry.spawnedWorkspaceDir,
          cwd: entry.spawnedCwd,
        });
        expectedParent = {
          sessionId: entry.spawnedBySessionId,
          lifecycleRevision: entry.parentSessionLifecycleRevision,
        };
        sessionKey = entry.spawnedBy;
        sourceSessionKeys.push(sessionKey);
        continue;
      }
      const accept = captureWorktreeRegistryReadGuard(context, "lifecycle");
      const worktree = await readRegistryWorktree(context, entry.worktree.id);
      const assertWorktreeCurrent = accept(worktree);
      assertSessionsCurrent();
      if (
        !worktree ||
        (inheritedWorktreeId && worktree.id !== inheritedWorktreeId) ||
        worktree.removedAt !== undefined ||
        worktree.ownerKind !== "session" ||
        worktree.ownerId !== sessionKey ||
        worktree.repoRoot !== entry.worktree.repoRoot ||
        worktree.branch !== entry.worktree.branch
      ) {
        throw new Error("Local sandbox managed workspace owner changed");
      }
      const workspaceDir =
        params.workspaceDir ?? inheritedSelections[0]?.workspaceDir ?? worktree.path;
      const paths = [
        workspaceDir,
        ...inheritedSelections.flatMap((selection) =>
          selection.cwd ? [selection.workspaceDir, selection.cwd] : [selection.workspaceDir],
        ),
      ];
      let projectionPath: string | undefined;
      if (paths.some((selected) => !isPathInside(worktree.path, selected))) {
        if (!params.inheritWorkspace) {
          throw new Error("Local sandbox managed workspace owner changed");
        }
        const reply = await executeExistingOpenClawStateRead(
          { path: context.admission.databasePath, env },
          { type: "localWorkspace.get", input: { id: worktree.id } },
          { context, current: true, live: true },
        );
        assertSessionsCurrent();
        assertWorktreeCurrent();
        const projection = reply?.type === "localWorkspace.get" && reply.ok ? reply.row : undefined;
        if (
          !projection ||
          projection.agent_id !== params.agentId ||
          projection.session_key !== sessionKey ||
          projection.session_id !== entry.sessionId ||
          projection.lifecycle_revision !== (entry.lifecycleRevision ?? null)
        ) {
          throw new Error("Local sandbox inherited workspace binding changed");
        }
        projectionPath = projection.projection_path;
      }
      const relativePath = (selected: string) => {
        if (isPathInside(worktree.path, selected)) {
          return path.relative(worktree.path, selected);
        }
        if (projectionPath && isPathInside(projectionPath, selected)) {
          return path.relative(projectionPath, selected);
        }
        throw new Error("Local sandbox managed workspace owner changed");
      };
      const workspaceRelativePath = relativePath(workspaceDir);
      // Runtime paths and recorded source paths use different coordinates for the same root.
      if (paths.some((selected) => relativePath(selected) !== workspaceRelativePath)) {
        throw new Error("Local sandbox inherited workspace binding changed");
      }
      const assertCurrent = () => {
        assertSessionsCurrent();
        assertWorktreeCurrent();
      };
      assertCurrent();
      return {
        agentId: params.agentId,
        sessionKey,
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision ?? null,
        workspaceRelativePath,
        sourceSessionKeys,
        worktree,
        assertCurrent,
        workerAuthority: {
          assertCurrent: assertSessionsCurrent,
          predicates: [{ kind: "live-binding", record: worktree }],
        },
        env,
        [Symbol.dispose]: () => lifetime.dispose(),
      };
    }
  } catch (error) {
    lifetime.dispose();
    throw error;
  }
}
