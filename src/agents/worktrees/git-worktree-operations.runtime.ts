import path from "node:path";
import {
  estimateCheckoutObjectBytes,
  estimateCheckoutTransitionBytes,
  measureDirectoryTreeBytes,
} from "./capacity.runtime.js";
import { splitNullBuffer } from "./git-path-inventory.js";
import type {
  GitWorktreeOperation,
  GitWorktreeOperationResult,
  GitWorktreeOperations,
} from "./git-worktree-operations.js";
import { requireGitBuffer, worktreePathExists } from "./git.js";
import {
  hasSafeParentDirectories,
  hasUnsnapshotableProvisionedFiles,
  lstatIfExists,
  normalizeProvisionedRelativePath,
  resolveGitPath,
} from "./provisioned-file-inspection.js";
import { inspectNestedRepository, snapshotWorktree } from "./snapshot-inventory.js";

async function inspectProvisioning(
  sourceRoot: string,
): Promise<GitWorktreeOperations["worktree.provisioning-inspection"]["output"]> {
  const includePath = path.join(sourceRoot, ".worktreeinclude");
  if (!(await worktreePathExists(includePath))) {
    return { paths: [], estimatedBytes: 0 };
  }
  const candidates = splitNullBuffer(
    await requireGitBuffer(sourceRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]),
  );
  const included = new Set(
    splitNullBuffer(
      await requireGitBuffer(sourceRoot, [
        "ls-files",
        "--others",
        "--ignored",
        `--exclude-from=${includePath}`,
        "-z",
      ]),
    ).map((entry) => entry.toString("utf8")),
  );
  const paths = candidates
    .map((entry) => entry.toString("utf8"))
    .filter((entry) => included.has(entry));
  let estimatedBytes = 0;
  for (const relativePath of paths) {
    const normalized = normalizeProvisionedRelativePath(relativePath);
    if (!normalized || !(await hasSafeParentDirectories(sourceRoot, normalized))) {
      continue;
    }
    const stat = await lstatIfExists(resolveGitPath(sourceRoot, normalized));
    if (stat?.isFile()) {
      estimatedBytes += Math.max(4096, stat.size);
    }
  }
  return { paths, estimatedBytes };
}

async function inspectCleanup(
  input: GitWorktreeOperations["worktree.cleanup-inspection"]["input"],
): Promise<GitWorktreeOperations["worktree.cleanup-inspection"]["output"]> {
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
    case "worktree.snapshot":
      return await snapshotWorktree(operation.input);
    case "worktree.provisioning-inspection":
      return await inspectProvisioning(operation.input.sourceRoot);
    case "worktree.cleanup-inspection":
      return await inspectCleanup(operation.input);
    case "worktree.git-size":
      return await estimateCheckoutObjectBytes(
        operation.input.repoRoot,
        operation.input.ref,
        operation.input.replacementRefBase,
      );
    case "worktree.checkout-transition-size":
      return await estimateCheckoutTransitionBytes(
        operation.input.repoRoot,
        operation.input.baseRef,
        operation.input.targetRef,
        operation.input.replacementRefBase,
      );
    case "worktree.directory-size":
      return await measureDirectoryTreeBytes(operation.input.root, operation.input.excludeGit);
    default:
      throw new Error("Unknown managed-worktree Git operation");
  }
}
