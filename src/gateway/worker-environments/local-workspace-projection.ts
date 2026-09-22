import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withWorktreeGitConfig } from "../../agents/worktrees/checkout-git-config.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  getRegistryWorktree,
  findLiveRegistryWorktreeByPath,
} from "../../agents/worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { localWorkspaceArchiveOperations } from "./local-workspace-archive.js";
import {
  admitLocalWorkspaceSourcePaths,
  selectLocalWorkspaceCanonicalPaths,
} from "./local-workspace-inventory.js";
import { localWorkspaceStore, type LocalWorkspaceProjection } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";
import { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspace,
  recoverWorkerWorkspaceReconciliation,
} from "./workspace-reconcile.js";
import {
  hasWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
  withStagedWorkerWorkspaceResult,
  deleteStagedWorkerWorkspaceResult,
} from "./workspace-result-staging.js";
import { runWorkspaceInventoryCommandToFile } from "./workspace-sync-inventory.js";

type Direction = "canonical" | "projection";

type LocalWorkspaceCustody = {
  prepareArchive: (snapshot: string) => Promise<void>;
  canonicalPaths: () => Promise<Set<string>>;
  assertCurrent: () => void;
};

/** Publication and lifecycle callers retain their own authority while joining local settlement. */
export async function withSettledLocalWorkspace<T>(
  params: {
    worktree: ManagedWorktreeRecord;
    env?: NodeJS.ProcessEnv;
    assertCurrent?: () => void;
    retireRuntime?: boolean;
    restoreSnapshot?: boolean;
    finishRestore?: boolean;
  },
  operation: (custody?: LocalWorkspaceCustody) => Promise<T>,
): Promise<T> {
  const store = localWorkspaceStore(params.env);
  const row = store.get(params.worktree.id);
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
            assertCurrent: () => {
              state.current();
            },
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

function assertBinding(row: LocalWorkspaceProjection, owner: LocalWorkspaceOwner) {
  owner.assertCurrent();
  if (
    row.worktree_id !== owner.worktree.id ||
    row.agent_id !== owner.agentId ||
    row.session_key !== owner.sessionKey ||
    row.session_id !== owner.sessionId ||
    row.lifecycle_revision !== owner.lifecycleRevision
  ) {
    throw new Error(
      "Local sandbox workspace belongs to a different session incarnation; pending edits were preserved",
    );
  }
}

function projectionPath(owner: LocalWorkspaceOwner) {
  if (!/^[a-f0-9-]{36}$/u.test(owner.worktree.id)) {
    throw new Error("Invalid managed worktree identity");
  }
  return path.join(
    realpathSync(resolveStateDir(owner.env)),
    "worktree-projections",
    owner.worktree.id,
    "workspace",
  );
}

async function assertOwnedDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw new Error("Local sandbox workspace directory changed; preserved for recovery");
  }
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
      const operations = projectionOperations({ ...owner, assertCurrent }, lease.signal);
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

function projectionOperations(owner: LocalWorkspaceOwner, signal: AbortSignal) {
  const store = localWorkspaceStore(owner.env);
  let row = store.get(owner.worktree.id);
  const current = () => {
    if (!row) {
      throw new Error("Local workspace binding is missing");
    }
    assertBinding(row, owner);
    if (
      row.projection_path !== projectionPath(owner) ||
      store.revision(row.worktree_id) !== row.revision
    ) {
      throw new Error("Local workspace binding changed");
    }
    return row;
  };
  const update = (patch: Parameters<typeof store.update>[1]) => {
    row = store.update(current(), patch, () => {
      current();
    });
    return row;
  };
  const sourcePath = (target: Direction) =>
    target === "canonical" ? current().projection_path : owner.worktree.path;
  const targetPath = (target: Direction) =>
    target === "canonical" ? owner.worktree.path : current().projection_path;
  const canonicalPaths = async () => {
    const selected = current();
    return await selectLocalWorkspaceCanonicalPaths({
      root: owner.worktree.path,
      admittedPaths: selected.source_paths_json,
      signal,
      assertCurrent: () => {
        current();
      },
      baseline:
        selected.baseline_json && selected.baseline_ref
          ? parseWorkerWorkspaceManifest(selected.baseline_json, selected.baseline_ref)
          : undefined,
    });
  };
  const capture = async (target: Direction) => {
    const selected = current();
    const root = sourcePath(target);
    await assertOwnedDirectory(root);
    current();
    // Never inspect guest Git metadata on the host. Canonical inventory uses only
    // the trusted managed worktree; ignored host files cannot enter the projection.
    const includePaths = target === "projection" ? await canonicalPaths() : undefined;
    const snapshot = await captureWorkspaceSnapshot({
      root,
      baseCommit: selected.base_commit,
      includePaths,
      signal,
    });
    current();
    return snapshot;
  };
  const recover = async () => {
    const selected = current();
    if (!selected.journal_json) {
      return;
    }
    if (
      !selected.journal_pack ||
      (selected.pending_target !== "canonical" && selected.pending_target !== "projection")
    ) {
      throw new Error("Local workspace recovery metadata is incomplete");
    }
    const journal = {
      ...parseWorkerWorkspaceReconciliationPlan(selected.journal_json),
      basePack: selected.journal_pack,
    };
    await recoverWorkerWorkspaceReconciliation({
      root: targetPath(selected.pending_target),
      journal,
    });
    update({ journal_json: null, journal_pack: null });
  };
  const cleanupAccepted = async () => {
    const selected = current();
    if (!selected.pending_ref || selected.pending_target) {
      return;
    }
    await deleteStagedWorkerWorkspaceResult({
      root: owner.worktree.repoRoot,
      stagedResultRef: selected.pending_ref,
    });
    update({ pending_ref: null });
  };
  const settle = async (retainAccepted = false) => {
    await recover();
    if (!retainAccepted) {
      await cleanupAccepted();
    }
    const selected = current();
    if (!selected.pending_ref) {
      return;
    }
    if (
      !selected.baseline_ref ||
      !selected.baseline_json ||
      (selected.pending_target !== "canonical" && selected.pending_target !== "projection")
    ) {
      throw new Error("Local workspace result has no accepted baseline");
    }
    const target = selected.pending_target;
    // Reservation precedes staging. A crash before its Git effect leaves the
    // source bytes untouched and resumes capture into this exact reserved ref.
    if (
      !(await hasWorkerWorkspaceResultRef({
        root: owner.worktree.path,
        stagedResultRef: selected.pending_ref,
      }))
    ) {
      const snapshot = await capture(target);
      await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root: owner.worktree.path,
        stagingRoot: sourcePath(target),
        stagedResultRef: selected.pending_ref,
        baseManifestRef: selected.baseline_ref,
        currentManifestRef: snapshot.manifestRef,
        baseManifestRaw: selected.baseline_json,
        currentManifestRaw: snapshot.rawManifest,
      });
      current();
    }
    let accepted:
      | { manifest: WorkerWorkspaceManifest; manifestRef: string; conflictPaths: string[] }
      | undefined;
    await withStagedWorkerWorkspaceResult(
      { root: owner.worktree.path, stagedResultRef: selected.pending_ref },
      async (snapshot) => {
        current();
        await applyStagedWorkerWorkspace({
          root: targetPath(target),
          stagingRoot: snapshot.stagingRoot,
          baseManifestRef: snapshot.baseManifestRef,
          currentManifestRef: snapshot.currentManifestRef,
          base: snapshot.base,
          current: snapshot.current,
          journal: {
            load: () => undefined,
            begin: (journal) => {
              update({
                journal_json: serializeWorkerWorkspaceReconciliationPlan(journal),
                journal_pack: journal.basePack,
              });
            },
            abort: () => {
              update({ journal_json: null, journal_pack: null });
            },
            commit: () => {
              if (!accepted) {
                throw new Error("Local workspace acceptance is missing");
              }
              // A conflicting result remains a durable pending receipt. No guest
              // bytes are discarded or silently replaced by the canonical side.
              try {
                update(
                  accepted.conflictPaths.length
                    ? { journal_json: null, journal_pack: null }
                    : {
                        baseline_json: serializeWorkerWorkspaceManifest(snapshot.current),
                        baseline_ref: snapshot.currentManifestRef,
                        // Retain the accepted ref until its Git cleanup completes.
                        pending_target: null,
                        journal_json: null,
                        journal_pack: null,
                      },
                );
              } catch (error) {
                throw new AcceptedWorkspacePublicationIndeterminateError(
                  "commit",
                  error,
                  undefined,
                );
              }
            },
          },
          acceptance: {
            kind: "reconcile",
            publish: async (value) => {
              current();
              accepted = value;
            },
          },
        });
      },
    );
    if (current().pending_target) {
      throw new Error(
        "Local sandbox edits conflict with the managed workspace; pending changes were preserved. Resolve the workspace conflicts before retrying.",
      );
    }
    if (!retainAccepted) {
      await cleanupAccepted();
    }
  };
  const synchronize = async (target: Direction) => {
    await settle();
    const snapshot = await capture(target);
    if (snapshot.manifestRef === current().baseline_ref) {
      return;
    }
    update({ pending_ref: workerWorkspaceResultRef(randomUUID()), pending_target: target });
    await settle();
  };
  const prepare = async () => {
    if (!row) {
      const baseCommit = await requireGit(
        owner.worktree.path,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        { signal, beforeRun: owner.assertCurrent },
      );
      const sourcePaths = await admitLocalWorkspaceSourcePaths({
        root: owner.worktree.path,
        signal,
        assertCurrent: owner.assertCurrent,
      });
      owner.assertCurrent();
      row = store.create(
        {
          worktree_id: owner.worktree.id,
          agent_id: owner.agentId,
          session_key: owner.sessionKey,
          session_id: owner.sessionId,
          lifecycle_revision: owner.lifecycleRevision,
          projection_path: projectionPath(owner),
          base_commit: baseCommit,
          source_paths_json: sourcePaths,
          baseline_json: null,
          baseline_ref: null,
          pending_ref: null,
          pending_target: null,
          journal_json: null,
          journal_pack: null,
          paused_runtimes_json: null,
          created_at_ms: Date.now(),
        },
        owner.assertCurrent,
      );
    }
    const selected = current();
    if (!selected.baseline_ref) {
      const parent = path.dirname(selected.projection_path);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      await assertOwnedDirectory(parent);
      current();
      // No runtime can use an uncommitted initial projection. Only this durable
      // reservation owns interrupted preparation; never recreate a ready checkout.
      await fs.rm(selected.projection_path, { recursive: true, force: true });
      const temporary = await fs.mkdtemp(path.join(parent, ".prepare-"));
      try {
        const pack = await withWorktreeGitConfig(
          owner.worktree.path,
          true,
          {
            signal,
            beforeRun: () => {
              current();
            },
          },
          (git) =>
            git.withContentEnvironment((baseEnv) =>
              prepareWorkerWorkspaceGitPack({
                root: owner.worktree.path,
                baseCommit: selected.base_commit,
                temporaryRoot: temporary,
                signal,
                baseEnv,
              }),
            ),
        );
        current();
        const repo = path.join(temporary, "workspace");
        await fs.mkdir(repo, { mode: 0o700 });
        const cleanEnv = {
          PATH: process.env.PATH,
          HOME: temporary,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_SYSTEM: os.devNull,
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
        };
        const git = (args: string[], input?: Uint8Array) =>
          requireGit(repo, args, {
            baseEnv: cleanEnv,
            env: cleanEnv,
            input,
            signal,
            beforeRun: () => {
              current();
            },
          });
        await git([
          "init",
          "--quiet",
          "--template=",
          "--object-format=" + (selected.base_commit.length === 40 ? "sha1" : "sha256"),
        ]);
        current();
        await runWorkspaceInventoryCommandToFile({
          argv: [
            "git",
            "-c",
            "core.hooksPath=" + os.devNull,
            "-c",
            "core.fsmonitor=false",
            "-C",
            repo,
            "index-pack",
            "--stdin",
          ],
          inputPath: pack,
          outputPath: path.join(temporary, "index-pack-result"),
          baseEnv: cleanEnv,
          signal,
          timeoutMs: 300_000,
          maxOutputBytes: 4096,
        });
        current();
        await fs.writeFile(path.join(repo, ".git", "shallow"), selected.base_commit + "\n", {
          mode: 0o600,
        });
        await git(["checkout", "--quiet", "-b", owner.worktree.branch, selected.base_commit]);
        const initial = await captureWorkspaceSnapshot({
          root: repo,
          baseCommit: selected.base_commit,
          signal,
        });
        current();
        await fs.rename(repo, selected.projection_path);
        update({ baseline_json: initial.rawManifest, baseline_ref: initial.manifestRef });
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }
    await assertOwnedDirectory(current().projection_path);
    await synchronize("canonical");
    await synchronize("projection");
    return current().projection_path;
  };
  return {
    current,
    canonicalPaths,
    prepare,
    synchronize,
    settle,
    recover,
    ...localWorkspaceArchiveOperations({
      owner,
      signal,
      current,
      update,
      capture,
      settle,
      recover,
      cleanupAccepted,
      assertDirectory: assertOwnedDirectory,
      deleteBinding: () => store.delete(current(), owner.assertCurrent),
    }),
    rememberPaused: (value: string | null) => {
      update({ paused_runtimes_json: value });
    },
  };
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
