import fs from "node:fs/promises";
import { extractErrorCode, isMissingPathError } from "../../infra/errors.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { WORKTREE_CHECKOUT_TIMEOUT_MS } from "./git.js";

export type WorktreeFilesystemOptions = {
  signal?: AbortSignal;
  commitGuard: () => void;
};

export interface WorktreeFilesystemBackend {
  id: string;
  createTemplate: (path: string, options: WorktreeFilesystemOptions) => Promise<void>;
  cloneTemplate: (
    source: string,
    destination: string,
    options: WorktreeFilesystemOptions,
  ) => Promise<void>;
}

// Linux's BTRFS_SUPER_MAGIC identifies the destination volume, not its mount name.
const BTRFS_SUPER_MAGIC = 0x9123683e;

function assertActive(options: WorktreeFilesystemOptions): void {
  options.signal?.throwIfAborted();
  options.commitGuard();
}

async function requireAbsentDestination(
  destination: string,
  options: WorktreeFilesystemOptions,
): Promise<void> {
  assertActive(options);
  try {
    await fs.lstat(destination);
  } catch (error) {
    assertActive(options);
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  assertActive(options);
  // Snapshotting onto an existing directory creates a child instead of failing.
  throw new Error(`Worktree filesystem destination already exists: ${destination}`);
}

async function runBtrfsMutation(
  args: string[],
  destination: string,
  options: WorktreeFilesystemOptions,
): Promise<void> {
  await requireAbsentDestination(destination, options);
  assertActive(options);
  const result = await runCommandWithTimeout(["btrfs", "--quiet", "subvolume", ...args], {
    timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    signal: options.signal,
    killProcessTree: true,
  });
  assertActive(options);
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(
      `Btrfs subvolume ${args[0]} failed: ${result.stderr.trim() || result.termination}`,
    );
  }
}

const btrfsBackend: WorktreeFilesystemBackend = {
  id: "btrfs",
  async createTemplate(destination, options) {
    await runBtrfsMutation(["create", "--", destination], destination, options);
  },
  async cloneTemplate(source, destination, options) {
    await runBtrfsMutation(["snapshot", "--", source, destination], destination, options);
  },
};

/** Probe without creating artifacts; the caller supplies an existing destination parent. */
export async function detectWorktreeFilesystemBackend(
  parentPath: string,
  options: WorktreeFilesystemOptions,
): Promise<WorktreeFilesystemBackend | null> {
  assertActive(options);
  if (process.platform !== "linux") {
    return null;
  }
  const volume = await fs.statfs(parentPath);
  assertActive(options);
  if (volume.type !== BTRFS_SUPER_MAGIC) {
    return null;
  }
  let result: SpawnResult;
  try {
    result = await runCommandWithTimeout(["btrfs", "--version"], {
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      signal: options.signal,
      killProcessTree: true,
    });
  } catch (error) {
    assertActive(options);
    const code = extractErrorCode(error);
    if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") {
      return null;
    }
    throw error;
  }
  assertActive(options);
  return result.termination === "exit" && result.code === 0 ? btrfsBackend : null;
}
