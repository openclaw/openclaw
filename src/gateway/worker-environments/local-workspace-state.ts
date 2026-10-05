import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../../agents/sandbox/types.js";
import type { WorktreeAllocationGuard } from "../../agents/worktrees/allocation.js";
import { splitNullBuffer } from "../../agents/worktrees/git-path-inventory.js";
import { requireGit, requireGitBuffer } from "../../agents/worktrees/git.js";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import type { WorktreeWorkerAuthority } from "../../agents/worktrees/types.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { prepareLocalWorkspaceCheckout } from "./local-workspace-checkout.js";
import {
  admitLocalWorkspaceSourcePaths,
  selectLocalWorkspaceCanonicalPaths,
} from "./local-workspace-inventory.js";
import { localWorkspaceStore, type LocalWorkspaceProjection } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceReconciliationPlan,
} from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";
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
  readStagedWorkerWorkspaceResult,
} from "./workspace-result-staging.js";

type Direction = "canonical" | "projection";

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

export function projectionOperations(
  owner: LocalWorkspaceOwner,
  signal: AbortSignal,
  initialRow: LocalWorkspaceProjection | undefined,
) {
  const store = localWorkspaceStore(owner.env);
  let row = initialRow;
  const selectCurrent = (assertCurrent: () => void) => {
    if (!row) {
      throw new Error("Local workspace binding is missing");
    }
    assertCurrent();
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
    if (
      row.projection_path !== projectionPath(owner) ||
      store.revision(row.worktree_id) !== row.revision
    ) {
      throw new Error("Local workspace binding changed");
    }
    return row;
  };
  const current = () => selectCurrent(() => owner.assertCurrent());
  const workerAuthority: WorktreeWorkerAuthority = {
    ...owner.workerAuthority,
    assertCurrent: () => selectCurrent(() => owner.workerAuthority?.assertCurrent?.()),
  };
  const update = (patch: Parameters<typeof store.update>[1]) => {
    row = store.update(current(), patch, current);
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
      assertCurrent: current,
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
    let conflictPaths: string[] | undefined;
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
            load: async () => undefined,
            begin: async (journal) => {
              update({
                journal_json: serializeWorkerWorkspaceReconciliationPlan(journal),
                journal_pack: journal.basePack,
              });
            },
            abort: async () => {
              update({ journal_json: null, journal_pack: null });
            },
            commit: async () => {
              if (!conflictPaths) {
                throw new Error("Local workspace acceptance is missing");
              }
              // A conflicting result remains a durable pending receipt. No guest
              // bytes are discarded or silently replaced by the canonical side.
              try {
                update(
                  conflictPaths.length
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
              conflictPaths = value.conflictPaths;
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
  const prepare = async (dependencies?: {
    sandbox: SandboxConfig;
    allocation: WorktreeAllocationGuard;
  }) => {
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
        const repo = path.join(temporary, "workspace");
        const checkout = {
          source: owner.worktree.path,
          destination: repo,
          temporaryRoot: temporary,
          baseCommit: selected.base_commit,
          branch: owner.worktree.branch,
          signal,
          assertCurrent: current,
        };
        const cloned =
          dependencies &&
          (await (
            await import("./local-workspace-template.js")
          ).cloneLocalWorkspaceTemplate({
            ...checkout,
            repoRoot: owner.worktree.repoRoot,
            templateRoot: path.dirname(parent),
            env: owner.env ?? process.env,
            sandbox: dependencies.sandbox,
            guard: {
              ...dependencies.allocation,
              signal: dependencies.allocation.signal
                ? AbortSignal.any([signal, dependencies.allocation.signal])
                : signal,
              commitGuard: () => {
                dependencies.allocation.commitGuard();
                current();
              },
            },
          }));
        if (!cloned) {
          await timeWorktreePreparationPhase("checkout", () =>
            prepareLocalWorkspaceCheckout(checkout),
          );
        }
        const initial = await timeWorktreePreparationPhase("snapshot", () =>
          captureWorkspaceSnapshot({
            root: repo,
            baseCommit: selected.base_commit,
            signal,
          }),
        );
        current();
        await fs.rename(repo, selected.projection_path);
        update({ baseline_json: initial.rawManifest, baseline_ref: initial.manifestRef });
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }
    await assertOwnedDirectory(current().projection_path);
    if (selected.baseline_ref) {
      await timeWorktreePreparationPhase("synchronizeCanonical", () => synchronize("canonical"));
    }
    await timeWorktreePreparationPhase("synchronizeProjection", () => synchronize("projection"));
    return current().projection_path;
  };
  return {
    current,
    workerAuthority,
    canonicalPaths,
    prepare,
    reuse: async () => (row?.baseline_ref ? await prepare() : undefined),
    synchronize,
    settle,
    recover,
    restoreSnapshot: async () => {
      await recover();
      const selected = current();
      if (!selected.pending_ref) {
        return;
      }
      if (!selected.pending_target) {
        // A failed restore may have applied the overlay before its checkout was
        // rolled back. Retain and replay the same accepted receipt on retry.
        const receipt = await readStagedWorkerWorkspaceResult(
          owner.worktree.repoRoot,
          selected.pending_ref,
        );
        current();
        if (receipt.currentManifestRef !== selected.baseline_ref) {
          throw new Error("Archive restore receipt changed");
        }
        update({
          baseline_json: serializeWorkerWorkspaceManifest(receipt.base),
          baseline_ref: receipt.baseManifestRef,
          pending_target: "canonical",
        });
      }
      await settle(true);
    },
    finishRestore: cleanupAccepted,
    prepareArchive: async (snapshotCommit: string) => {
      await settle();
      const accepted = await capture("canonical");
      if (accepted.manifestRef !== current().baseline_ref) {
        throw new Error("Local workspace changed before archive capture");
      }
      const projection = current().projection_path;
      // Git omits accepted ignored leaves and empty directories; retain only that delta.
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(snapshotCommit)) {
        throw new Error("Invalid archive snapshot commit");
      }
      const listed = await requireGitBuffer(
        owner.worktree.repoRoot,
        ["ls-tree", "-r", "-z", "--name-only", snapshotCommit],
        {
          signal,
          beforeRun: current,
          maxOutputBytes: 64 * 1024 * 1024,
        },
      );
      current();
      const paths = new Set(splitNullBuffer(listed).map((entry) => entry.toString("hex")));
      const entries = accepted.manifest.entries.filter((entry) =>
        paths.has(Buffer.from(entry.path).toString("hex")),
      );
      const directories = new Set<string>();
      for (const entry of entries) {
        for (const parent of workspacePathAncestors(entry.path)) {
          directories.add(parent);
        }
      }
      const base = serializeWorkerWorkspaceManifest({
        ...accepted.manifest,
        entries,
        directories: [...directories].toSorted(),
      });
      const baseRef = "sha256:" + createHash("sha256").update(base).digest("hex");
      if (baseRef === accepted.manifestRef) {
        return;
      }
      const resultRef = workerWorkspaceResultRef(randomUUID());
      // Reservation precedes the Git effect. Interrupted staging recaptures the
      // still-owned projection against this same reduced base on ordinary recovery.
      update({
        baseline_json: base,
        baseline_ref: baseRef,
        pending_ref: resultRef,
        pending_target: "canonical",
      });
      await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root: owner.worktree.repoRoot,
        stagingRoot: projection,
        stagedResultRef: resultRef,
        baseManifestRaw: base,
        baseManifestRef: baseRef,
        currentManifestRaw: serializeWorkerWorkspaceManifest(accepted.manifest),
        currentManifestRef: accepted.manifestRef,
      });
      current();
    },
    expire: async (retireSnapshot?: (assertCurrent: () => void) => Promise<void>) => {
      const selected = current();
      if (
        selected.journal_json ||
        (selected.pending_target && selected.pending_target !== "canonical")
      ) {
        throw new Error("Local sandbox has pending edits; restore its worktree before cleanup");
      }
      let accepted =
        selected.baseline_json && selected.baseline_ref
          ? { raw: selected.baseline_json, ref: selected.baseline_ref }
          : undefined;
      if (selected.pending_ref) {
        if (!retireSnapshot || owner.worktree.removedAt === undefined) {
          throw new Error("Archive receipt still owns its restore data");
        }
        if (selected.pending_target) {
          const receipt = await readStagedWorkerWorkspaceResult(
            owner.worktree.repoRoot,
            selected.pending_ref,
          );
          current();
          if (receipt.baseManifestRef !== selected.baseline_ref) {
            throw new Error("Archive retention receipt changed");
          }
          accepted = {
            raw: serializeWorkerWorkspaceManifest(receipt.current),
            ref: receipt.currentManifestRef,
          };
        }
      }
      if (accepted && (await capture("canonical")).manifestRef !== accepted.ref) {
        throw new Error("Local sandbox has unaccepted edits; restore its worktree before cleanup");
      }
      const { readLocalWorkspaceRuntimes } =
        await import("../../agents/sandbox/local-workspace-quiescence.js");
      if ((await readLocalWorkspaceRuntimes(selected.projection_path)).length) {
        throw new Error("Local sandbox runtime still owns its workspace; cleanup deferred");
      }
      const parent = path.dirname(selected.projection_path);
      await assertOwnedDirectory(parent);
      current();
      // Once expiry starts, an older restore must not find a usable Git snapshot
      // after its accepted overlay has been retired.
      await retireSnapshot?.(current);
      current();
      if (selected.pending_ref && accepted) {
        update({ baseline_json: accepted.raw, baseline_ref: accepted.ref, pending_target: null });
        await cleanupAccepted();
      }
      await fs.rm(parent, { recursive: true, force: true });
      store.delete(current(), owner.assertCurrent);
    },
    rememberPaused: (value: string | null) => {
      update({ paused_runtimes_json: value });
    },
  };
}
