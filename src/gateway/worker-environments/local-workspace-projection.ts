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
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { projectionOperations } from "./local-workspace-state.js";
import { withLocalWorkspaceStore, type LocalWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

type LocalWorkspaceCustody = {
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
  return await withLocalWorkspaceStore(
    { ...params, env, worktreeId: params.worktree.id },
    async (store) => {
      const row = store.get();
      if (!row) {
        return await operation({
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
          await quiescence?.retire();
        }
        owner.assertCurrent();
        return await operation(
          state.current().baseline_ref
            ? {
                prepareArchive: state.prepareArchive,
                canonicalPaths: state.canonicalPaths,
                assertCurrent: state.current,
                workerAuthority: state.workerAuthority,
              }
            : { assertCurrent: store.assertCurrent, workerAuthority: store.workerAuthority },
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
  options: { provision?: boolean } = {},
) {
  return await withLocalWorkspaceStore({ ...owner, worktreeId: owner.worktree.id }, (store) =>
    runLocalWorkspaceProjection(owner, store, run, options),
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
    assertCurrent: () => {
      store.workerAuthority.assertCurrent?.();
      owner.workerAuthority?.assertCurrent?.();
    },
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
      ? await quiesceLocalWorkspace({
          workspaceDir: previous.projection_path,
          retained: parseLocalWorkspacePausedRuntimes(previous.paused_runtimes_json),
          persist: (runtimes) =>
            operations.rememberPaused(runtimes.length ? JSON.stringify(runtimes) : null),
          assertCurrent,
        })
      : undefined;
  try {
    return await run(operations, quiescence);
  } finally {
    // Only acknowledged journal changes allow the frozen guest to resume.
    const retained = store.get();
    if (retained && !retained.journal_json) {
      await quiescence?.resume();
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

/** Bind only a live session-owned managed checkout, never an arbitrary host path. */
export async function resolveLocalWorkspaceOwner(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<LocalWorkspaceOwner | undefined> {
  const context = captureWorktreeRunEndContext(params.env ?? process.env);
  const env = { ...(params.env ?? process.env), ...context.environment };
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: params.agentId,
      env,
    }),
    env,
  };
  const entry = loadSessionEntry(scope);
  if (!entry?.worktree?.id) {
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
    params.assertCurrent?.();
    const now = loadSessionEntry(scope);
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
  return {
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
  };
}
