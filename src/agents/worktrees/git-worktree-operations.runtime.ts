import fs from "node:fs/promises";
import path from "node:path";
import { lstatIfExists } from "../../infra/path-existence.js";
import {
  estimateCheckoutObjectBytes,
  estimateCheckoutTransitionBytes,
  measureDirectoryTreeBytes,
} from "./capacity.runtime.js";
import {
  classifyWorktreeEvictions,
  prepareWorktreeEvictionRepositories,
  purgeWorktreeCheckout,
  readWorktreeSourceDependencies,
} from "./eviction.runtime.js";
import { readWorktreeCleanupFingerprint } from "./gc-fingerprint.runtime.js";
import { splitNullBuffer } from "./git-path-inventory.js";
import type {
  GitWorktreeOperation,
  GitWorktreeOperationResult,
  GitWorktreeOperations,
} from "./git-worktree-operations.js";
import { commandError, requireGitBuffer, runGitBuffered, worktreePathExists } from "./git.js";
import {
  hasSafeParentDirectories,
  hasUnsnapshotableProvisionedFiles,
  normalizeProvisionedRelativePath,
  resolveGitPath,
} from "./provisioned-file-inspection.js";

async function inspectProvisioning(
  sourceRoot: string,
  estimateBytes = true,
): Promise<GitWorktreeOperations["worktree.provisioning-inspection"]["output"]> {
  const includePath = path.join(sourceRoot, ".worktreeinclude");
  if (!(await worktreePathExists(includePath))) {
    return { paths: [], estimatedBytes: 0 };
  }
  // Git can silently ignore non-file exclude inputs instead of reporting an error.
  // Resolve symlinks as Git does, while rejecting an invalid manifest explicitly.
  if (!(await fs.stat(includePath)).isFile()) {
    throw new Error(".worktreeinclude must resolve to a regular file");
  }
  const included = await requireGitBuffer(sourceRoot, [
    "ls-files",
    "--others",
    "--ignored",
    `--exclude-from=${includePath}`,
    "-z",
  ]);
  if (included.length === 0) {
    return { paths: [], estimatedBytes: 0 };
  }
  // The inventory is untracked; skip index glob matching and use ./ to reject pathspec magic.
  const result = await runGitBuffered(sourceRoot, ["check-ignore", "--no-index", "--stdin", "-z"], {
    input: splitNullBuffer(included)
      .map((entry) => `./${entry.toString("utf8")}\0`)
      .join(""),
  });
  if (result.termination !== "exit" || (result.code !== 0 && result.code !== 1)) {
    throw commandError("git check-ignore", result);
  }
  const paths = splitNullBuffer(result.stdout).map((entry) => entry.toString("utf8").slice(2));
  let estimatedBytes = 0;
  for (const relativePath of estimateBytes ? paths : []) {
    const normalized = normalizeProvisionedRelativePath(relativePath);
    if (!normalized || !(await hasSafeParentDirectories(sourceRoot, normalized))) {
      continue;
    }
    const stat = await lstatIfExists(resolveGitPath(sourceRoot, normalized), "ENOENT");
    if (stat?.isFile()) {
      estimatedBytes += Math.max(4096, stat.size);
    }
  }
  return { paths, estimatedBytes };
}

async function inspectCleanup(
  input: GitWorktreeOperations["worktree.cleanup-inspection"]["input"],
): Promise<GitWorktreeOperations["worktree.cleanup-inspection"]["output"]> {
  const { inspectNestedRepository } = await import("./snapshot-inventory.js");
  if (input.kind === "nested-repository") {
    return {
      retainedReason: (await inspectNestedRepository(input.checkoutPath))
        ? "nested-repository"
        : undefined,
    };
  }
  if (input.kind === "provisioned") {
    return {
      retainedReason: (await hasUnsnapshotableProvisionedFiles(
        input.checkoutPath,
        input.provisionedPaths,
      ))
        ? "provisioned-drift"
        : undefined,
    };
  }
  const status = await requireGitBuffer(input.checkoutPath, ["status", "--porcelain"]);
  const unpushed = await requireGitBuffer(input.checkoutPath, [
    "log",
    "HEAD",
    "--not",
    "--remotes",
    "--oneline",
  ]);
  const drift = await hasUnsnapshotableProvisionedFiles(input.checkoutPath, input.provisionedPaths);
  return {
    retainedReason: status.toString("utf8").trim()
      ? "dirty"
      : unpushed.toString("utf8").trim()
        ? "unpushed"
        : drift
          ? "provisioned-drift"
          : (await inspectNestedRepository(input.checkoutPath))
            ? "nested-repository"
            : undefined,
  };
}

export async function executeGitWorktreeOperation(
  operation: GitWorktreeOperation,
): Promise<GitWorktreeOperationResult> {
  switch (operation.type) {
    case "worktree.eviction-source":
      return readWorktreeSourceDependencies(operation.input);
    case "worktree.eviction-repositories":
      return await prepareWorktreeEvictionRepositories(operation.input.repoRoots);
    case "worktree.eviction-classify":
      return await classifyWorktreeEvictions(operation.input.records);
    case "worktree.eviction-purge":
      return await purgeWorktreeCheckout(operation.input.record, operation.input.live);
    case "worktree.cleanup-fingerprint":
      return await readWorktreeCleanupFingerprint(operation.input.checkoutPath);
    case "worktree.snapshot-verify-exact": {
      const { verifyExactStateSnapshot } = await import("./snapshot-inventory.js");
      return await verifyExactStateSnapshot(operation.input);
    }
    case "worktree.snapshot": {
      const { snapshotWorktree } = await import("./snapshot-inventory.js");
      return await snapshotWorktree(operation.input);
    }
    case "worktree.provisioning-inspection":
      return await inspectProvisioning(operation.input.sourceRoot, operation.input.estimateBytes);
    case "worktree.cleanup-inspection":
      return await inspectCleanup(operation.input);
    case "worktree.git-size":
      return await estimateCheckoutObjectBytes(
        operation.input.repoRoot,
        operation.input.ref,
        operation.input.replacementRefBase,
        operation.input.preparationKey,
      );
    case "worktree.checkout-transition-size":
      return await estimateCheckoutTransitionBytes(
        operation.input.repoRoot,
        operation.input.baseRef,
        operation.input.targetRef,
        operation.input.replacementRefBase,
      );
    case "worktree.directory-size":
      return await measureDirectoryTreeBytes(operation.input.root);
    default:
      throw new Error("Unknown managed-worktree Git operation");
  }
}
