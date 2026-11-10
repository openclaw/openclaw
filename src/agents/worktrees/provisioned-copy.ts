import fs from "node:fs/promises";
import type { ProvisionCopyDetails } from "../../infra/fs-safe-copy-worker-contract.js";
import { root as fsRoot, FsSafeError, type Root } from "../../infra/fs-safe.js";
import { lstatIfExists } from "../../infra/path-existence.js";
import { copyProvisionedPathsLinux } from "./provisioned-copy-linux.js";
import {
  hasSafeParentDirectories,
  normalizeProvisionedRelativePath,
  resolveGitPath,
} from "./provisioned-file-inspection.js";

async function copyProvisionedFile(params: {
  sourceRoot: Root;
  destinationRoot: Root;
  relativePath: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  copyDetails?: ProvisionCopyDetails;
}): Promise<boolean> {
  const relativePath = params.relativePath;
  // Eligibility checks preserve skip behavior; copyIn guards the later mutation.
  if (
    !(await hasSafeParentDirectories(params.sourceRoot.rootReal, relativePath)) ||
    !(await hasSafeParentDirectories(params.destinationRoot.rootReal, relativePath))
  ) {
    return false;
  }
  const source = resolveGitPath(params.sourceRoot.rootReal, relativePath);
  const destination = resolveGitPath(params.destinationRoot.rootReal, relativePath);
  const sourceStat = await fs.lstat(source).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
    return false;
  }
  if (await lstatIfExists(destination, "ENOENT")) {
    return false;
  }
  try {
    // Absolute spellings preserve Git's literal "~" and POSIX drive-like filenames.
    await params.destinationRoot.copyIn(
      destination,
      { root: params.sourceRoot, relativePath: source },
      {
        overwrite: false,
        clone: "auto",
        maxBytes: Infinity,
        preserveSourceMode: true,
        preserveMetadata: true,
        sourceHardlinks: "allow",
        mutationSymlinks: "reject",
        durable: false,
        assertBeforeMutation: params.assertCurrent,
        signal: params.signal,
      },
    );
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "already-exists") {
      // Existing checkout state is user-owned. Never mutate or claim it as provisioned.
      return false;
    }
    throw error;
  }
  params.assertCurrent?.();
  if (params.copyDetails) {
    params.copyDetails.sourceBytes += sourceStat.size;
  }
  return true;
}

/** The worker native section retains every copy descriptor through settlement. */
export async function copyProvisionedPaths(
  repoRoot: string,
  worktreePath: string,
  paths: readonly string[],
  options: {
    signal?: AbortSignal;
    assertCurrent?: () => void;
    copyDetails?: ProvisionCopyDetails;
  },
): Promise<string[]> {
  const [sourceRoot, destinationRoot] = await Promise.all([fsRoot(repoRoot), fsRoot(worktreePath)]);
  options.signal?.throwIfAborted();
  const linuxCopy = await copyProvisionedPathsLinux(sourceRoot, destinationRoot, paths, options);
  if (linuxCopy) {
    return linuxCopy;
  }
  const provisioned: string[] = [];
  for (const relativePath of paths) {
    const normalized = normalizeProvisionedRelativePath(relativePath);
    if (
      normalized &&
      (await copyProvisionedFile({
        sourceRoot,
        destinationRoot,
        relativePath: normalized,
        assertCurrent: options.assertCurrent,
        signal: options.signal,
        copyDetails: options.copyDetails,
      }))
    ) {
      provisioned.push(normalized);
    }
  }
  return provisioned.toSorted();
}
