import fs from "node:fs/promises";
import path from "node:path";
import { runGit, requireGit } from "../../agents/worktrees/git.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { withWorkspaceResultRefMutation } from "./workspace-result-git.js";
import {
  requireWorkerResultStorageRef,
  isLocalWorkspaceBaseRefreshRef,
  WORKER_RESULT_REF_PREFIX,
  WORKER_RESULT_CANDIDATE_REF_PREFIX,
  WORKER_RESULT_CLEANUP_REF_PREFIX,
} from "./workspace-result-inventory.js";

const STORAGE_DIRECTORY = "openclaw-worker-results";

export type WorkspaceResultStorage = {
  root: string;
  baseEnv: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  commonDir?: string;
  isolated: boolean;
};

function privateStorage(root: string, baseEnv: NodeJS.ProcessEnv): WorkspaceResultStorage {
  // The Git worker broker owns baseEnv; explicit per-command deletions survive
  // that boundary even when a pooled worker never inherited the parent's override.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    [
      "DIR",
      "COMMON_DIR",
      "WORK_TREE",
      "INDEX_FILE",
      "OBJECT_DIRECTORY",
      "ALTERNATE_OBJECT_DIRECTORIES",
      "NAMESPACE",
      "SHALLOW_FILE",
      "GRAFT_FILE",
      "REPLACE_REF_BASE",
    ].map((name) => [`GIT_${name}`, undefined]),
  );
  return { root, commonDir: root, baseEnv: { ...baseEnv, ...env }, env, isolated: true };
}

function resultDirectory(gitDir: string, ref: string): string {
  const identity = ref.slice(ref.lastIndexOf("/") + 1);
  return path.join(
    gitDir,
    STORAGE_DIRECTORY,
    isLocalWorkspaceBaseRefreshRef(ref) ? `base-refresh-${identity}` : `result-${identity}`,
  );
}

async function repository(root: string, baseEnv: NodeJS.ProcessEnv) {
  const probe = await runGit(root, ["rev-parse", "--absolute-git-dir", "--show-object-format"], {
    baseEnv,
    maxOutputBytes: 1024 * 1024,
  });
  if (probe.termination !== "exit" || probe.code !== 0) {
    return undefined;
  }
  const output = probe.stdout.replace(/\r?\n$/u, "");
  const separator = output.lastIndexOf("\n");
  const common = output.slice(0, separator);
  return {
    gitDir: normalizeGitPathForFilesystem(
      process.platform === "win32" ? common.replace(/\r$/u, "") : common,
    ),
    format: output.slice(separator + 1),
  };
}

export async function resolveWorkspaceResultStorage(
  root: string,
  ref: string,
): Promise<WorkspaceResultStorage> {
  requireWorkerResultStorageRef(ref);
  const baseEnv = { ...process.env };
  const source = await repository(root, baseEnv);
  if (source) {
    const directory = resultDirectory(source.gitDir, ref);
    try {
      await fs.access(directory);
      return privateStorage(directory, baseEnv);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  // Stable releases retained recovery/conflict refs in the original repository.
  // Keep those readable until their existing settlement owner releases them.
  return { root, baseEnv, isolated: false };
}

export async function createWorkspaceResultStorage(
  root: string,
  ref: string,
  assertCurrent?: () => void,
): Promise<WorkspaceResultStorage> {
  requireWorkerResultStorageRef(ref);
  const baseEnv = { ...process.env };
  let source = await repository(root, baseEnv);
  if (!source) {
    assertCurrent?.();
    await requireGit(root, ["init", "--quiet", "--object-format=sha1"], {
      baseEnv,
      beforeRun: assertCurrent,
    });
    source = (await repository(root, baseEnv))!;
  }
  const identity = ref.slice(ref.lastIndexOf("/") + 1);
  const legacyRefs = isLocalWorkspaceBaseRefreshRef(ref)
    ? [ref]
    : [
        WORKER_RESULT_REF_PREFIX,
        WORKER_RESULT_CANDIDATE_REF_PREFIX,
        WORKER_RESULT_CLEANUP_REF_PREFIX,
      ].map((prefix) => `${prefix}/${identity}`);
  if (
    await requireGit(root, ["for-each-ref", "--count=1", "--format=%(refname)", ...legacyRefs], {
      baseEnv,
    })
  ) {
    // Pre-upgrade claims can retry their candidate after restart. Finish those
    // in their original store so a private candidate cannot shadow retained refs.
    return { root, baseEnv, isolated: false };
  }
  const directory = resultDirectory(source.gitDir, ref);
  const storage = privateStorage(directory, baseEnv);
  assertCurrent?.();
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  assertCurrent?.();
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!hasErrnoCode(error, "EEXIST")) {
      throw error;
    }
  }
  try {
    await requireGit(
      directory,
      ["init", "--quiet", "--bare", "--template=", `--object-format=${source.format}`],
      { baseEnv: storage.baseEnv, env: storage.env, beforeRun: assertCurrent },
    );
    return storage;
  } catch (error) {
    if (created) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

/** The same ref queue protects both the last-ref check and its object deletion. */
export async function deleteEmptyWorkspaceResultStorage(
  storage: WorkspaceResultStorage,
): Promise<void> {
  if (!storage.isolated) {
    return;
  }
  await withWorkspaceResultRefMutation(
    storage.root,
    async (baseEnv) => {
      const ref = await requireGit(
        storage.root,
        ["for-each-ref", "--count=1", "--format=%(refname)"],
        {
          baseEnv,
          env: storage.env,
        },
      );
      if (!ref) {
        await fs.rm(storage.root, { recursive: true, force: true });
      }
    },
    { commonDir: storage.root, baseEnv: storage.baseEnv },
  );
}

export async function workspaceResultCleanupStores(
  root: string,
): Promise<WorkspaceResultStorage[]> {
  const baseEnv = { ...process.env };
  const source = await repository(root, baseEnv);
  const stores: WorkspaceResultStorage[] = [{ root, baseEnv, isolated: false }];
  if (!source) {
    return stores;
  }
  // A linked worktree owns its results; scanning siblings here multiplies startup cleanup.
  const directory = path.join(source.gitDir, STORAGE_DIRECTORY);
  try {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        (!entry.name.startsWith("result-") && !entry.name.startsWith("base-refresh-"))
      ) {
        continue;
      }
      stores.push(privateStorage(path.join(directory, entry.name), baseEnv));
    }
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  return stores;
}
