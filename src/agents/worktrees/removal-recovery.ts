import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { runOutsideCommandProcessScope } from "../../process/exec-spawn.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import { requireWorktreeDiskSpace } from "./capacity.js";
import { withWorktreeGitConfig } from "./checkout-git-config.js";
import { lockState } from "./git-lock.js";
import { splitNullBuffer } from "./git-path-inventory.js";
import { commandError, listGitWorktrees, requireGit, requireGitBuffer, runGit } from "./git.js";
import {
  assertWorktreeRemovalClaim,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  updateRegistryWorktree,
} from "./registry.js";
import {
  prepareSnapshotBranchDeletion,
  removeManagedCheckout,
  withExactStateGitLocks,
} from "./removal-git.js";
import { createRemovalRecoveryInventory } from "./removal-recovery-inventory.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import { resolveRepository } from "./service-preparation.js";

const preserved = (reason: string) =>
  new Error(`${reason}; remaining source and original snapshot preserved`);
const stat = async (target: string) =>
  fs.lstat(target).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });

/** CLI-only recovery: reconstitute a clean checkout without replacing any surviving file,
 * then let native non-force Git removal own deletion. Dirty/exact-state captures keep their
 * existing recovery owners; neither their index nor their snapshots can be reconstructed here.
 */
export async function recoverManagedWorktreeRemoval(
  params: { id: string; snapshot: string; signal?: AbortSignal; commitGuard?: () => void },
  context: { env: NodeJS.ProcessEnv; now: () => number },
) {
  return await withWorktreeAllocationLease({ ...params, env: context.env }, async (guard) =>
    recoverRemovalWithAllocation({ ...params, ...guard, ...context }),
  );
}

async function recoverRemovalWithAllocation(params: {
  id: string;
  snapshot: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  signal?: AbortSignal;
  commitGuard?: () => void;
}) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(params.snapshot)) {
    throw preserved("Expected a full snapshot commit id");
  }
  const record = getRegistryWorktree(params.env, params.id);
  if (!record || record.snapshotRef !== `refs/openclaw/snapshots/${params.id}`) {
    throw preserved("Recovery requires an ordinary removal snapshot");
  }
  const repository = await resolveRepository(record.repoRoot);
  if (
    repository.fingerprint !== record.repoFingerprint ||
    repository.repoRoot !== record.repoRoot
  ) {
    throw preserved("Worktree repository identity changed");
  }
  const pendingRef = `refs/openclaw/removals/${record.id}`;
  const removalRefs = [record.snapshotRef!, pendingRef, `refs/heads/${record.branch}`];
  const assertDirectRefFiles = () => {
    for (const ref of removalRefs) {
      const filename = path.join(repository.commonDir, ref);
      const info = fsSync.lstatSync(filename, { throwIfNoEntry: false });
      // Packed refs cannot be symbolic. A loose replacement must be an ordinary
      // direct-ref file; no awaited work separates this check from Git admission.
      if (
        info &&
        (!info.isFile() ||
          info.nlink !== 1 ||
          fsSync.readFileSync(filename, "utf8").startsWith("ref:"))
      ) {
        throw preserved("Removal refs must remain direct refs");
      }
    }
  };
  const assertDirectRefs = async (options: Parameters<typeof runGit>[2]) => {
    for (const ref of removalRefs) {
      const symbolic = await runGit(record.repoRoot, ["symbolic-ref", "--quiet", ref], options);
      if (symbolic.code !== 1) {
        throw preserved("Removal refs must remain direct refs");
      }
    }
  };
  // Listing may retire an absent path before Git finishes its administration.
  // Keep that lifecycle removed, but resume its original metadata under a claim.
  const retiredRegistration =
    record.removedAt !== undefined &&
    (
      await listGitWorktrees(record.repoRoot, {
        signal: params.signal,
        beforeRun: params.commitGuard,
        env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
      })
    ).some((entry) => path.resolve(entry.path) === record.path);
  if (record.removedAt !== undefined && !retiredRegistration) {
    // A crash after registry publication can leave only the pending pin. The
    // allocation lease excludes restore; revalidate its exact lifecycle before CAS.
    const assertTerminal = () => {
      params.commitGuard?.();
      assertDirectRefFiles();
      if (JSON.stringify(getRegistryWorktree(params.env, record.id)) !== JSON.stringify(record)) {
        throw preserved("Completed removal lifecycle changed");
      }
    };
    const options = {
      signal: params.signal,
      beforeRun: assertTerminal,
      env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
    };
    await assertDirectRefs(options);
    if (
      (await stat(record.path)) ||
      (await listGitWorktrees(record.repoRoot, options)).some(
        (entry) => path.resolve(entry.path) === record.path,
      ) ||
      (await requireGit(record.repoRoot, ["rev-parse", record.snapshotRef!], options)) !==
        params.snapshot
    ) {
      throw preserved("Completed removal identity changed");
    }
    const pending = await runGit(
      record.repoRoot,
      ["rev-parse", "--verify", "--quiet", pendingRef],
      options,
    );
    const branch = await runGit(
      record.repoRoot,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`],
      options,
    );
    if (pending.code === 1) {
      if (branch.code !== 1) {
        throw preserved("Completed removal branch changed");
      }
    } else {
      if (pending.code !== 0 || pending.stdout.trim() !== params.snapshot) {
        throw preserved("Pending snapshot changed");
      }
      if (branch.code !== 1) {
        const head = await requireGit(
          record.repoRoot,
          ["rev-parse", `${params.snapshot}^`],
          options,
        );
        if (branch.code !== 0 || branch.stdout.trim() !== head) {
          throw preserved("Recorded branch changed");
        }
        const deletion = await prepareSnapshotBranchDeletion(
          record,
          record.snapshotRef!,
          params.snapshot,
          options,
        );
        await requireGit(record.repoRoot, ["branch", "-d", "--", record.branch], deletion);
      }
      await requireGit(record.repoRoot, ["update-ref", "--stdin"], {
        ...options,
        input: `option no-deref\nverify ${record.snapshotRef} ${params.snapshot}\noption no-deref\ndelete ${pendingRef} ${params.snapshot}\n`,
      });
    }
    return { removed: true as const, snapshotRef: record.snapshotRef };
  }
  const token = randomUUID();
  const assertRecord = () => {
    params.commitGuard?.();
    params.signal?.throwIfAborted();
    const current = getRegistryWorktree(params.env, record.id);
    if (JSON.stringify(current) !== JSON.stringify(record)) {
      throw preserved("Worktree registry changed during recovery");
    }
  };
  assertRecord();
  claimWorktreeRemoval(params.env, {
    worktreeId: record.id,
    token,
    ...(retiredRegistration ? { retiredRemoval: true as const } : {}),
    assertCurrent: assertRecord,
  });
  const assertCurrent = () => {
    assertRecord();
    assertDirectRefFiles();
    assertWorktreeRemovalClaim(params.env, record.id, token);
  };
  const options = {
    signal: params.signal,
    beforeRun: assertCurrent,
    killProcessTree: true,
    env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
  };
  try {
    const provisioned = await getRegistryWorktreeProvisionedPaths(params.env, record.id);
    if (!provisioned || provisioned.length) {
      throw preserved("Provisioned-file recovery requires its original archive owner");
    }
    // A projection can retain ignored guest data outside the ordinary Git capture.
    const { localWorkspaceStore } =
      await import("../../gateway/worker-environments/local-workspace-store.js");
    if (localWorkspaceStore(params.env).get(record.id)) {
      throw preserved("Projected worktree recovery requires its original archive owner");
    }
    const head = await requireGit(record.repoRoot, ["rev-parse", `${params.snapshot}^`], options);
    if (
      (await requireGit(record.repoRoot, ["rev-parse", `${head}^{tree}`], options)) !==
      (await requireGit(record.repoRoot, ["rev-parse", `${params.snapshot}^{tree}`], options))
    ) {
      throw preserved("Recovery requires an unchanged captured tree");
    }
    const assertRefs = async (allowAbsentBranch = false) => {
      await assertDirectRefs(options);
      for (const ref of [record.snapshotRef!, pendingRef]) {
        if (
          (await requireGit(record.repoRoot, ["rev-parse", "--verify", ref], options)) !==
          params.snapshot
        ) {
          throw preserved("Removal snapshot ref changed");
        }
      }
      const branch = await runGit(
        record.repoRoot,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${record.branch}`],
        options,
      );
      if (
        branch.code === 0 ? branch.stdout.trim() !== head : !allowAbsentBranch || branch.code !== 1
      ) {
        throw preserved("Recorded branch changed");
      }
      assertCurrent();
    };
    await assertRefs(!(await stat(record.path)));
    const state = await lockState(record);
    if (state.kind === "live" || state.kind === "foreign") {
      throw preserved("Worktree is locked or in use");
    }
    // A still-present administrative index is the authority for a partial checkout.
    // Match the exact backlink, never infer administrative ownership from its basename.
    const registrations = await listGitWorktrees(record.repoRoot, options);
    const registered = registrations.some((entry) => path.resolve(entry.path) === record.path);
    const originalRoot = await stat(record.path);
    if (retiredRegistration && originalRoot) {
      throw preserved("Retired checkout path reappeared");
    }
    let admin: string | undefined;
    if (registered) {
      const adminRoot = path.join(repository.commonDir, "worktrees");
      for (const name of await fs.readdir(adminRoot)) {
        const candidate = path.join(adminRoot, name);
        if (!(await stat(candidate))?.isDirectory()) {
          continue;
        }
        const backlink = await fs.readFile(path.join(candidate, "gitdir"), "utf8").catch(() => "");
        if (
          path.resolve(candidate, normalizeGitPathForFilesystem(backlink.trim())) ===
          path.join(record.path, ".git")
        ) {
          if (admin) {
            throw preserved("Ambiguous worktree registration");
          }
          admin = candidate;
        }
      }
      if (!admin) {
        throw preserved("Original worktree administration is unavailable");
      }
    }
    if (
      originalRoot &&
      (!originalRoot.isDirectory() || !admin || (await fs.realpath(record.path)) !== record.path)
    ) {
      throw preserved("Worktree path identity is unavailable");
    }
    let assertAdmin = () => {};
    if (admin) {
      const gitdir = admin;
      const adminIdentity = await fs.lstat(gitdir);
      const indexOptions = {
        ...options,
        env: { ...options.env, GIT_DIR: gitdir, GIT_INDEX_FILE: path.join(gitdir, "index") },
      };
      const sharedIndex = await requireGit(
        record.repoRoot,
        ["rev-parse", "--shared-index-path"],
        indexOptions,
      );
      const metadataNames = ["HEAD", "gitdir", "commondir", "index"];
      if (sharedIndex) {
        const shared = path.resolve(record.repoRoot, normalizeGitPathForFilesystem(sharedIndex));
        if (
          path.dirname(shared) !== gitdir ||
          !/^sharedindex\.[a-f0-9]+$/u.test(path.basename(shared))
        ) {
          throw preserved("Original split index identity changed");
        }
        metadataNames.push(path.basename(shared));
      }
      const worktreeConfig = path.join(gitdir, "config.worktree");
      const hadWorktreeConfig = Boolean(await stat(worktreeConfig));
      if (hadWorktreeConfig) {
        metadataNames.push("config.worktree");
      }
      const metadata = await Promise.all(
        metadataNames.map(async (name) => {
          const filename = path.join(gitdir, name);
          const identity = await fs.lstat(filename);
          if (!identity.isFile() || identity.nlink !== 1) {
            throw preserved("Original Git metadata is aliased");
          }
          return { filename, identity, bytes: await fs.readFile(filename) };
        }),
      );
      assertAdmin = () => {
        assertCurrent();
        if (!hadWorktreeConfig && fsSync.lstatSync(worktreeConfig, { throwIfNoEntry: false })) {
          throw preserved("Original Git configuration changed");
        }
        const currentAdmin = fsSync.lstatSync(gitdir);
        if (currentAdmin.dev !== adminIdentity.dev || currentAdmin.ino !== adminIdentity.ino) {
          throw preserved("Worktree administration identity changed");
        }
        for (const saved of metadata) {
          const current = fsSync.lstatSync(saved.filename);
          if (
            current.dev !== saved.identity.dev ||
            current.ino !== saved.identity.ino ||
            current.mode !== saved.identity.mode ||
            current.nlink !== saved.identity.nlink ||
            !fsSync.readFileSync(saved.filename).equals(saved.bytes)
          ) {
            throw preserved("Original Git metadata changed");
          }
        }
        assertCurrent();
      };
      if (
        (await fs.realpath(gitdir)) !== gitdir ||
        path.resolve(
          gitdir,
          normalizeGitPathForFilesystem(
            (await fs.readFile(path.join(gitdir, "commondir"), "utf8")).trim(),
          ),
        ) !== repository.commonDir ||
        (await fs.readFile(path.join(gitdir, "HEAD"), "utf8")).trim() !==
          `ref: refs/heads/${record.branch}`
      ) {
        throw preserved("Original Git metadata identity changed");
      }
      const indexed = await requireGitBuffer(
        record.repoRoot,
        ["ls-files", "--stage", "-v", "-z"],
        indexOptions,
      );
      if (splitNullBuffer(indexed).some((entry) => entry[0] !== 72)) {
        throw preserved("Original index has hidden or unmerged entries");
      }
      const clean = await runGit(
        record.repoRoot,
        ["diff-index", "--cached", "--quiet", params.snapshot, "--"],
        indexOptions,
      );
      if (clean.code !== 0) {
        throw preserved("Original index differs from the capture");
      }
    }
    if (originalRoot && admin) {
      const gitdir = admin;
      const gitfile = path.join(record.path, ".git");
      const assertIdentity = () => {
        assertCurrent();
        assertAdmin();
        const current = fsSync.lstatSync(record.path, { throwIfNoEntry: false });
        if (current?.dev !== originalRoot.dev || current.ino !== originalRoot.ino) {
          throw preserved("Checkout or original index changed");
        }
        const marker = fsSync.lstatSync(gitfile, { throwIfNoEntry: false });
        if (marker) {
          if (!marker.isFile() || marker.nlink !== 1) {
            throw preserved("Checkout Git link changed");
          }
          const text = fsSync.readFileSync(gitfile, "utf8").trim();
          const target = text.startsWith("gitdir: ")
            ? path.resolve(record.path, normalizeGitPathForFilesystem(text.slice(8)))
            : "";
          const matches =
            process.platform === "win32"
              ? target.toLowerCase() === gitdir.toLowerCase()
              : target === gitdir;
          if (!matches) {
            throw preserved("Checkout Git link changed");
          }
        }
      };
      const inventory = await createRemovalRecoveryInventory({
        record,
        snapshot: params.snapshot,
        gitdir,
        options,
        assertIdentity,
        refuse: preserved,
      });
      const missing = await inventory.verify();
      await assertRefs();
      requireWorktreeDiskSpace(
        [
          {
            path: record.path,
            bytes: inventory.missingBytes(missing),
          },
        ],
        "interrupted removal recovery",
      );
      // Exclusive creation repairs only this backlink. Never rebuild/replace the index,
      // and never run repository-wide repair or prune as part of recovery.
      if (!(await stat(gitfile))) {
        assertIdentity();
        await fs.writeFile(gitfile, `gitdir: ${gitdir}\n`, { flag: "wx", mode: 0o600 });
      }
      if (state.kind === "dead") {
        await requireGit(record.repoRoot, ["worktree", "unlock", record.path], options);
      }
      // checkout-index without --force refuses to overwrite any concurrently created path.
      // The trusted content view disables repository filters during reconstruction.
      if (missing.length) {
        await withWorktreeGitConfig(
          record.path,
          true,
          { ...options, beforeRun: assertIdentity },
          async (git) => {
            await git.require(
              record.path,
              [`--attr-source=${params.snapshot}`, "checkout-index", "--stdin", "-z"],
              {
                ...options,
                beforeRun: assertIdentity,
                input: Buffer.from(`${missing.join("\0")}\0`),
              },
            );
          },
        );
      }
      await withExactStateGitLocks(
        record,
        assertIdentity,
        async () => {
          if ((await inventory.verify()).length) {
            throw preserved("Reconstruction is incomplete");
          }
          await assertRefs();
          assertIdentity();
          await withWorktreeGitConfig(
            record.path,
            true,
            options,
            async (git) =>
              // The trusted status view cannot execute repository filters.
              // No await separates the final inventory from native admission.
              await removeManagedCheckout(record, git, true, inventory.assertComplete),
          );
        },
        [record.snapshotRef!, pendingRef],
      );
    } else if (registered) {
      await assertRefs();
      assertAdmin();
      await withWorktreeGitConfig(
        record.repoRoot,
        true,
        options,
        async (git) =>
          await runOutsideCommandProcessScope(() =>
            git.require(record.repoRoot, ["worktree", "remove", "--", record.path], {
              beforeRun: () => {
                assertCurrent();
                assertAdmin();
                if (fsSync.lstatSync(record.path, { throwIfNoEntry: false })) {
                  throw preserved("Missing checkout reappeared before destructive admission");
                }
              },
              killProcessTree: true,
              waitForExit: true,
            }),
          ),
      );
    }
    await assertRefs(true);
    if (
      (await stat(record.path)) ||
      (await listGitWorktrees(record.repoRoot, options)).some(
        (entry) => path.resolve(entry.path) === record.path,
      )
    ) {
      throw preserved("Checkout removal did not finish");
    }
    const branch = await runGit(
      record.repoRoot,
      ["show-ref", "--verify", "--quiet", `refs/heads/${record.branch}`],
      options,
    );
    if (branch.code === 0) {
      const deletion = await prepareSnapshotBranchDeletion(
        record,
        record.snapshotRef!,
        params.snapshot,
        options,
      );
      await assertRefs();
      await requireGit(record.repoRoot, ["branch", "-d", "--", record.branch], deletion);
    } else if (branch.code !== 1) {
      throw commandError("git show-ref", branch);
    }
    await assertRefs(true);
    assertCurrent();
    updateRegistryWorktree(
      params.env,
      record.id,
      { removedAt: record.removedAt ?? params.now() },
      { assertCurrent, removalToken: token },
    );
    const finalized = JSON.stringify(getRegistryWorktree(params.env, record.id));
    await requireGit(record.repoRoot, ["update-ref", "--stdin"], {
      beforeRun: () => {
        params.commitGuard?.();
        assertDirectRefFiles();
        assertWorktreeRemovalClaim(params.env, record.id, token);
        if (JSON.stringify(getRegistryWorktree(params.env, record.id)) !== finalized) {
          throw preserved("Completed removal lifecycle changed");
        }
      },
      env: options.env,
      input: `option no-deref\nverify ${record.snapshotRef} ${params.snapshot}\noption no-deref\ndelete ${pendingRef} ${params.snapshot}\n`,
    });
    await fs.rmdir(path.dirname(record.path)).catch(() => undefined);
    return { removed: true as const, snapshotRef: record.snapshotRef };
  } finally {
    abortWorktreeRemoval(params.env, record.id, token);
  }
}
