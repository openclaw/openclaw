import {
  getRegistryWorktree,
  findLiveRegistryWorktreeByPath,
} from "../../agents/worktrees/registry.js";
import type {
  ManagedWorktreeRecord,
  WorktreeWorkerAuthority,
} from "../../agents/worktrees/types.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { projectionOperations } from "./local-workspace-state.js";
import { localWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

type LocalWorkspaceCustody = {
  prepareArchive: (snapshot: string) => Promise<void>;
  canonicalPaths: () => Promise<Set<string>>;
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
  const row = localWorkspaceStore(params.env).get(params.worktree.id);
  if (!row) {
    return await operation();
  }
  const worktree = params.worktree;
  const owner: LocalWorkspaceOwner = {
    worktree,
    env: params.env,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    lifecycleRevision: row.lifecycle_revision,
    workerAuthority: {
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
    },
    assertCurrent: () => {
      params.assertCurrent?.();
      const current = getRegistryWorktree(params.env ?? process.env, worktree.id);
      if (
        !current ||
        current.ownerKind !== "session" ||
        current.ownerId !== row.session_key ||
        current.path !== worktree.path ||
        current.repoRoot !== worktree.repoRoot
      ) {
        throw new Error("Managed projection owner changed during settlement");
      }
    },
  };
  return await withLocalWorkspaceProjection(owner, async (state, quiescence) => {
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
        : undefined,
    );
  });
}

export async function withSettledLocalWorkspacePath<T>(
  params: { cwd: string; assertCurrent?: () => void },
  operation: (custody?: LocalWorkspaceCustody) => Promise<T>,
): Promise<T> {
  const record = findLiveRegistryWorktreeByPath(process.env, params.cwd);
  return record
    ? await withSettledLocalWorkspace(
        { worktree: record, assertCurrent: params.assertCurrent },
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
  return await withOpenClawStateLease(
    {
      scope: "workspace.local-reconciliation",
      key: owner.worktree.id,
      database: { scope: "shared", options: { env: owner.env } },
      leaseMs: 60_000,
      waitMs: 600_000,
      leaseLabel: "local sandbox workspace",
      operationLabel: "workspace.local-reconciliation",
    },
    async (lease) => {
      const assertCurrent = () => {
        lease.assertOwned();
        owner.assertCurrent();
      };
      assertCurrent();
      const store = localWorkspaceStore(owner.env);
      let previous = store.get(owner.worktree.id);
      // Reset advances the execution generation without replacing the conversation.
      // The current session owner may recover its own prior result; a new session ID
      // can never adopt that pending data, even when it reuses the key or checkout.
      if (
        previous &&
        previous.session_id === owner.sessionId &&
        previous.session_key === owner.sessionKey &&
        previous.agent_id === owner.agentId &&
        previous.lifecycle_revision !== owner.lifecycleRevision
      ) {
        previous = store.update(
          previous,
          { lifecycle_revision: owner.lifecycleRevision },
          assertCurrent,
        );
      }
      const operations = projectionOperations(
        {
          ...owner,
          assertCurrent,
          workerAuthority: {
            ...owner.workerAuthority,
            assertCurrent: () => {
              lease.assertOwned();
              (owner.workerAuthority
                ? owner.workerAuthority.assertCurrent
                : owner.assertCurrent)?.();
            },
          },
        },
        lease.signal,
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
        // A partially applied projection remains frozen until its exact journal
        // has recovered. Never let a resumed guest race crash recovery.
        const retained = localWorkspaceStore(owner.env).get(owner.worktree.id);
        if (retained && !retained.journal_json) {
          await quiescence?.resume();
        }
      }
    },
  );
}

/** Expiry belongs to the existing worktree retention owner, never sandbox pruning. */
export async function expireLocalWorkspaceProjection(params: {
  worktree: ManagedWorktreeRecord;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  retireSnapshot?: (assertCurrent: () => void) => Promise<void>;
}) {
  const row = localWorkspaceStore(params.env).get(params.worktree.id);
  if (!row) {
    await params.retireSnapshot?.(params.assertCurrent);
    return;
  }
  if (params.worktree.removedAt === undefined) {
    throw new Error("Cannot expire a live sandbox workspace");
  }
  const owner: LocalWorkspaceOwner = {
    worktree: params.worktree,
    env: params.env,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    lifecycleRevision: row.lifecycle_revision,
    assertCurrent: () => {
      params.assertCurrent();
      const record = getRegistryWorktree(params.env, params.worktree.id);
      if (record?.removedAt !== params.worktree.removedAt || record?.ownerId !== row.session_key) {
        throw new Error("Workspace retention owner changed");
      }
    },
  };
  await withLocalWorkspaceProjection(owner, (state) => state.expire(params.retireSnapshot));
}

/** Bind only a live session-owned managed checkout, never an arbitrary host path. */
export function resolveLocalWorkspaceOwner(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): LocalWorkspaceOwner | undefined {
  const env = params.env ?? process.env;
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
  const worktree = getRegistryWorktree(env, entry.worktree.id);
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
  const assertCurrent = () => {
    params.assertCurrent?.();
    const now = loadSessionEntry(scope);
    const current = getRegistryWorktree(env, worktree.id);
    if (
      now?.sessionId !== entry.sessionId ||
      now?.lifecycleRevision !== entry.lifecycleRevision ||
      now?.archivedAt !== undefined ||
      now?.worktree?.id !== worktree.id ||
      current?.removedAt !== undefined ||
      current?.ownerId !== params.sessionKey ||
      current?.path !== worktree.path ||
      current?.repoRoot !== worktree.repoRoot
    ) {
      throw new Error("Local sandbox workspace authority changed");
    }
  };
  assertCurrent();
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision ?? null,
    worktree,
    assertCurrent,
    env,
  };
}
