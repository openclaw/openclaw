import fs from "node:fs/promises";
import path from "node:path";
import { requireGit } from "../../agents/worktrees/git.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  findGitRoot,
  readGitMetadataDirectories,
  readGitDirectoryPointer,
  readGitRefs,
  resolveGitRefsBase,
} from "../../infra/git-root.js";
import { withWorkspaceResultRefMutation } from "./workspace-result-git.js";
import {
  isLocalWorkspaceBaseRefreshRef,
  WORKER_RESULT_REF_PREFIX,
  WORKER_RESULT_CANDIDATE_REF_PREFIX,
  WORKER_RESULT_CLEANUP_REF_PREFIX,
} from "./workspace-result-inventory.js";

const privateEnv: NodeJS.ProcessEnv = Object.fromEntries(
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

export type WorkspaceResultStorage = {
  root: string;
  baseEnv: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  commonDir?: string;
  isolated: boolean;
  refs?: string[];
  historyAlternates?: string;
};

function resultRefs(ref: string): string[] {
  return isLocalWorkspaceBaseRefreshRef(ref)
    ? [ref]
    : [
        WORKER_RESULT_REF_PREFIX,
        WORKER_RESULT_CANDIDATE_REF_PREFIX,
        WORKER_RESULT_CLEANUP_REF_PREFIX,
      ].map((prefix) => `${prefix}/${ref.slice(ref.lastIndexOf("/") + 1)}`);
}

export async function resolveWorkspaceResultStorage(
  root: string,
  ref: string,
  create?: { assertCurrent?: () => void },
): Promise<WorkspaceResultStorage> {
  const original: WorkspaceResultStorage = { root, baseEnv: { ...process.env }, isolated: false };
  let source: { gitDir: string; commonDir: string } | undefined;
  if (original.baseEnv.GIT_DIR !== undefined) {
    let gitDir = path.resolve(root, original.baseEnv.GIT_DIR);
    if ((await fs.stat(gitDir)).isFile()) {
      gitDir = readGitDirectoryPointer(gitDir, "gitdir: ");
    }
    await fs.access(path.join(gitDir, "HEAD"));
    source = { gitDir, commonDir: resolveGitRefsBase(path.join(gitDir, "HEAD")) };
  } else {
    source = readGitMetadataDirectories(root);
  }
  const repositoryRoot = source ? undefined : findGitRoot(root);
  source ??= repositoryRoot ? readGitMetadataDirectories(repositoryRoot) : undefined;
  if (repositoryRoot && !source) {
    throw new Error("Cannot read workspace Git metadata");
  }
  if (!source && create) {
    create.assertCurrent?.();
    await requireGit(root, ["init", "--quiet", "--object-format=sha1"], {
      baseEnv: original.baseEnv,
      beforeRun: create.assertCurrent,
    });
    source = readGitMetadataDirectories(root)!;
  }
  if (!source) {
    return original;
  }
  const commonDir = original.baseEnv.GIT_COMMON_DIR
    ? path.resolve(root, original.baseEnv.GIT_COMMON_DIR)
    : source.commonDir;
  original.commonDir = commonDir;
  const directory = path.join(
    source.gitDir,
    "openclaw-worker-results",
    `${isLocalWorkspaceBaseRefreshRef(ref) ? "base-refresh" : "result"}-${ref.slice(ref.lastIndexOf("/") + 1)}`,
  );
  const storage: WorkspaceResultStorage = {
    root: directory,
    commonDir: directory,
    baseEnv: original.baseEnv,
    env: privateEnv,
    isolated: true,
    refs: resultRefs(ref),
    historyAlternates: create
      ? [
          JSON.stringify(
            path.resolve(
              root,
              original.baseEnv.GIT_OBJECT_DIRECTORY ?? path.join(commonDir, "objects"),
            ),
          ),
          original.baseEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES,
        ]
          .filter(Boolean)
          .join(path.delimiter)
      : undefined,
  };
  try {
    await fs.access(directory);
    Object.assign(storage.baseEnv, privateEnv);
    return storage;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  // Stable claims finish in their original store, including packed recovery refs.
  if (!create || [...readGitRefs(commonDir, storage.refs!).values()].some(Boolean)) {
    return original;
  }
  const format = await requireGit(root, ["rev-parse", "--show-object-format"], original);
  create.assertCurrent?.();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  Object.assign(storage.baseEnv, privateEnv);
  try {
    await requireGit(
      directory,
      ["init", "--quiet", "--bare", "--template=", `--object-format=${format}`],
      { ...storage, beforeRun: create.assertCurrent },
    );
    return storage;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The existing queue protects the last-ref decision and its object deletion. */
export async function deleteEmptyWorkspaceResultStorage(
  storage: WorkspaceResultStorage,
): Promise<void> {
  if (!storage.isolated) {
    return;
  }
  await withWorkspaceResultRefMutation(
    storage.root,
    async () => {
      if (![...readGitRefs(storage.root, storage.refs!).values()].some(Boolean)) {
        await fs.rm(storage.root, { recursive: true, force: true });
      }
    },
    storage,
  );
}
