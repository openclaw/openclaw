import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { commandError, requireGit, runGit } from "../../agents/worktrees/git.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { workerSshCommandOptions } from "./ssh.js";
import {
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import { runWorkspaceInventoryCommandToFile } from "./workspace-sync-inventory.js";

const GIT_TIMEOUT_MS = 10 * 60_000;
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export type WorkerProjectSnapshot = { key: string; root: string; baseCommit: string };

export function workerProjectSeedKey(project: Pick<WorkerProjectSnapshot, "key" | "baseCommit">) {
  return createHash("sha256").update(`${project.key}\0${project.baseCommit}`).digest("hex");
}

export async function prepareWorkerProjectSnapshot(params: {
  localPath: string;
  namespace: string;
  baseCommit?: string;
  signal?: AbortSignal;
}): Promise<WorkerProjectSnapshot | undefined> {
  params.signal?.throwIfAborted();
  const root = await fsp.realpath(params.localPath);
  const gitAdmin = await fsp.lstat(path.join(root, ".git")).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (!gitAdmin) {
    if (params.baseCommit !== undefined) {
      throw new Error("Pinned worker project snapshot is no longer available");
    }
    return undefined;
  }
  const options = {
    timeoutMs: GIT_TIMEOUT_MS,
    signal: params.signal,
    env: workerSshCommandOptions({ timeoutMs: GIT_TIMEOUT_MS }).baseEnv,
  };
  const gitRoot = await fsp.realpath(
    await requireGit(root, ["rev-parse", "--show-toplevel"], options),
  );
  if (gitRoot !== root) {
    throw new Error("Worker git workspace sync requires the managed worktree root");
  }
  if (params.baseCommit !== undefined && !COMMIT_PATTERN.test(params.baseCommit)) {
    throw new Error("Worker project snapshot is not a commit id");
  }
  const head = await runGit(
    root,
    ["rev-parse", "--verify", "--quiet", `${params.baseCommit ?? "HEAD"}^{commit}`],
    options,
  );
  if (head.code === 1 && params.baseCommit === undefined) {
    return undefined;
  }
  if (head.code !== 0) {
    throw commandError("git rev-parse", head);
  }
  const baseCommit = head.stdout.trim();
  if (!COMMIT_PATTERN.test(baseCommit)) {
    throw new Error("Worker workspace Git base is not a commit id");
  }
  const commonDir = await fsp.realpath(
    await requireGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options),
  );
  params.signal?.throwIfAborted();
  // Linked session worktrees share the repository cache; their pinned commits and
  // mutable overlays must not create a new project identity.
  const key = createHash("sha256")
    .update(JSON.stringify([params.namespace, commonDir]))
    .digest("hex");
  return { key, root, baseCommit };
}

export async function prepareWorkerWorkspaceGitPack(params: {
  root: string;
  baseCommit: string;
  retainedCommit?: string;
  temporaryRoot: string;
  signal: AbortSignal;
}): Promise<string> {
  const { root, baseCommit, signal } = params;
  if (!COMMIT_PATTERN.test(baseCommit)) {
    throw new Error("Worker workspace Git base is not a commit id");
  }
  if (
    params.retainedCommit !== undefined &&
    (!COMMIT_PATTERN.test(params.retainedCommit) ||
      params.retainedCommit.length !== baseCommit.length)
  ) {
    throw new Error("Worker workspace retained Git base is not a compatible commit id");
  }
  const objectListPath = path.join(params.temporaryRoot, `${baseCommit}.objects`);
  const packPath = path.join(params.temporaryRoot, `${baseCommit}.pack`);
  try {
    let retainedCommit = params.retainedCommit;
    if (retainedCommit) {
      const donor = await requireGit(
        root,
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        {
          input: `${retainedCommit}\n`,
          env: { GIT_NO_LAZY_FETCH: "1" },
          signal,
          timeoutMs: GIT_TIMEOUT_MS,
        },
      );
      // An image can outlive rewritten Gateway history. Missing local donor data
      // uses the existing full snapshot path; corrupt or invalid objects still fail.
      if (donor === `${retainedCommit} missing`) {
        retainedCommit = undefined;
      } else if (donor !== `${retainedCommit} commit`) {
        throw new Error("Worker workspace retained Git base is not a commit");
      }
    }
    if (retainedCommit) {
      // A retained snapshot owns its commit and tree, not its source-side ancestors.
      // Bound both walks so a thin pack never borrows an unadvertised ancestor object.
      await fsp.writeFile(
        objectListPath,
        `--shallow ${baseCommit}\n--shallow ${retainedCommit}\n${baseCommit}\n^${retainedCommit}\n`,
      );
    } else {
      await runWorkspaceInventoryCommandToFile({
        argv: [
          "git",
          "-C",
          root,
          "rev-list",
          "--objects",
          "--no-object-names",
          `${baseCommit}^{tree}`,
        ],
        outputPath: objectListPath,
        signal,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: MAX_WORKSPACE_INVENTORY_PATH_BYTES,
      });
      await fsp.appendFile(objectListPath, `${baseCommit}\n`);
    }
    await runWorkspaceInventoryCommandToFile({
      argv: [
        "git",
        "-C",
        root,
        "pack-objects",
        "--stdout",
        ...(retainedCommit ? ["--revs", "--thin", "--shallow", "--delta-base-offset"] : []),
      ],
      inputPath: objectListPath,
      outputPath: packPath,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
    });
    return packPath;
  } catch (error) {
    // Exclusive output creation must be retryable after a failed download.
    await fsp.rm(objectListPath, { force: true });
    await fsp.rm(packPath, { force: true });
    throw error;
  }
}
