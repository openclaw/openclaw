import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { createGitCommandError, requireGitCommandOutput } from "../../infra/git-exec.js";
import type { GitWorktreeOperations } from "./git-worktree-operations.js";
import {
  requireGit,
  requireGitBuffer,
  runGit,
  runGitBuffered,
  WORKTREE_CHECKOUT_TIMEOUT_MS,
} from "./git.js";

async function missingCommitObjects(repoRoot: string, commit: string): Promise<string[]> {
  const objects = (
    await requireGitBuffer(
      repoRoot,
      ["rev-list", "--objects", "--missing=print", "--no-object-names", "--max-count=1", commit],
      { env: { GIT_NO_LAZY_FETCH: "1" } },
    )
  ).toString("utf8");
  return objects
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1));
}

async function readOptionalGitConfig(repoRoot: string, args: string[]): Promise<string> {
  const result = await runGit(repoRoot, ["config", ...args]);
  return result.termination === "exit" && result.code === 1
    ? ""
    : requireGitCommandOutput(`git config ${args.join(" ")}`, result).trim();
}

function missingObjectsError(commit: string, count: number): Error {
  return new Error(
    `Repository is missing ${count} objects for ${commit}; fetch or repair the clone.`,
  );
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  return await requireGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref === "-" ? "@{-1}" : ref}^{commit}`,
  ]);
}

async function hydrateCommitObjects(repoRoot: string, commit: string): Promise<void> {
  const missing = await missingCommitObjects(repoRoot, commit);
  if (missing.length > 0) {
    const remote =
      (await readOptionalGitConfig(repoRoot, ["--get", "extensions.partialclone"])) ||
      /^remote\.(.+)\.promisor true$/m.exec(
        await readOptionalGitConfig(repoRoot, [
          "--bool",
          "--get-regexp",
          "^remote\\..*\\.promisor$",
        ]),
      )?.[1];
    if (!remote) {
      throw missingObjectsError(commit, missing.length);
    }
    // Hydrate once under the checkout budget; objectsize must never fetch one blob at a time.
    // Shared commits do not prove that their promised blobs are present.
    // --refetch hints auto-maintenance into a full repack of the source repository, so keep
    // this sizing fetch from running gc there, like every other fetch in the product.
    await requireGit(
      repoRoot,
      [
        "fetch",
        "--refetch",
        "--no-auto-maintenance",
        remote,
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--stdin",
      ],
      { input: Buffer.from(`${missing.join("\n")}\n`), timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
    );
  }
}

function allocatedBlobBytes(size: string): number {
  const value = Number(size);
  if (!size || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "Cannot estimate worktree checkout size; inspect the repository objects and retry.",
    );
  }
  return Math.max(4096, Math.ceil(value / 4096) * 4096);
}

// This projection belongs to the Git worker and disappears when that worker
// idles out or the Gateway closes it. Never retain missing-object checks here.
const checkoutSizeFacts = new Map<string, number>();
const MAX_CHECKOUT_SIZE_FACTS = 32;

async function commitObjectBytes(
  repoRoot: string,
  commit: string,
  replacementRefBase: string | undefined,
): Promise<number> {
  const replacements =
    replacementRefBase === undefined
      ? undefined
      : await requireGit(repoRoot, [
          "for-each-ref",
          "--format=%(refname)",
          "--",
          replacementRefBase,
        ]);
  let cacheKey: string | undefined;
  if (replacements === "") {
    const canonicalRoot = await fs.realpath(repoRoot);
    const identity = await fs.stat(canonicalRoot);
    cacheKey = JSON.stringify([canonicalRoot, identity.dev, identity.ino, commit]);
    const cached = checkoutSizeFacts.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  try {
    const sizes = (
      await requireGitBuffer(repoRoot, ["ls-tree", "-r", "--format=%(objectsize)", commit, "--"], {
        env: { GIT_NO_LAZY_FETCH: "1" },
      })
    ).toString("utf8");
    let bytes = 0;
    for (const size of sizes.split("\n")) {
      if (!size || size === "-") {
        continue;
      }
      bytes += allocatedBlobBytes(size);
    }
    if (cacheKey) {
      checkoutSizeFacts.set(cacheKey, bytes);
      while (checkoutSizeFacts.size > MAX_CHECKOUT_SIZE_FACTS) {
        checkoutSizeFacts.delete(checkoutSizeFacts.keys().next().value!);
      }
    }
    return bytes;
  } catch (error) {
    const remaining = await missingCommitObjects(repoRoot, commit);
    if (remaining.length > 0) {
      throw missingObjectsError(commit, remaining.length);
    }
    throw error;
  }
}

export async function estimateCheckoutObjectBytes(
  repoRoot: string,
  ref: string,
  replacementRefBase?: string,
): Promise<number> {
  const commit = await resolveCommit(repoRoot, ref);
  await hydrateCommitObjects(repoRoot, commit);
  return await commitObjectBytes(repoRoot, commit, replacementRefBase);
}

export async function estimateCheckoutTransitionBytes(
  repoRoot: string,
  baseRef: string,
  targetRef: string,
  replacementRefBase?: string,
): Promise<GitWorktreeOperations["worktree.checkout-transition-size"]["output"]> {
  const base = await resolveCommit(repoRoot, baseRef);
  const target = await resolveCommit(repoRoot, targetRef);
  // Template validation can need blobs that the target deletes. Hydrate both
  // histories, while sharing identical commits within this admitted operation.
  await hydrateCommitObjects(repoRoot, base);
  if (target !== base) {
    await hydrateCommitObjects(repoRoot, target);
  }
  const targetBytes = await commitObjectBytes(repoRoot, target, replacementRefBase);
  if (target === base) {
    return { targetBytes, changedBytes: 0, requiresFullCheckout: false };
  }
  const diff = await runGitBuffered(
    repoRoot,
    [
      "diff-tree",
      "--no-commit-id",
      "--raw",
      "-z",
      "--no-renames",
      "--no-abbrev",
      "-r",
      base,
      target,
      "--",
    ],
    { env: { GIT_NO_LAZY_FETCH: "1" } },
  );
  if (diff.termination === "output-limit") {
    // A large diff cannot justify a partial allocation estimate or rule out
    // attribute changes. Keep the buffer bounded and materialize the full target.
    return { targetBytes, changedBytes: targetBytes, requiresFullCheckout: true };
  }
  if (diff.termination !== "exit" || diff.code !== 0) {
    throw createGitCommandError("git diff-tree", diff);
  }
  const changes = diff.stdout.toString("utf8").split("\0");
  if (changes.at(-1) !== "" || changes.length % 2 !== 1) {
    throw new Error(
      "Cannot estimate worktree overlay size; inspect the repository diff and retry.",
    );
  }
  const blobs: string[] = [];
  let checkoutAttributesChanged = false;
  for (let offset = 0; offset < changes.length - 1; offset += 2) {
    // --no-renames gives one metadata record and one raw path per change.
    // Count every destination path, even when multiple paths share one blob.
    const metadata = /^:[0-7]{6} ([0-7]{6}) [a-f0-9]+ ([a-f0-9]+) [AMDT]$/u.exec(changes[offset]!);
    if (!metadata || changes[offset + 1] === undefined) {
      throw new Error(
        "Cannot estimate worktree overlay size; inspect the repository diff and retry.",
      );
    }
    const changedPath = changes[offset + 1]!;
    checkoutAttributesChanged ||=
      changedPath === ".gitattributes" || changedPath.endsWith("/.gitattributes");
    if (metadata[1] !== "000000" && metadata[1] !== "160000") {
      blobs.push(metadata[2]!);
    }
  }
  // read-tree does not rewrite unchanged paths when attributes change. The
  // caller must rematerialize the target so its checkout transforms apply.
  if (checkoutAttributesChanged) {
    return {
      targetBytes,
      changedBytes: targetBytes,
      requiresFullCheckout: true,
    };
  }
  if (blobs.length === 0) {
    return { targetBytes, changedBytes: 0, requiresFullCheckout: false };
  }
  const sizes = (
    await requireGitBuffer(repoRoot, ["cat-file", "--batch-check=%(objecttype) %(objectsize)"], {
      input: Buffer.from(`${blobs.join("\n")}\n`),
      env: { GIT_NO_LAZY_FETCH: "1" },
    })
  )
    .toString("utf8")
    .trimEnd()
    .split("\n");
  if (sizes.length !== blobs.length || sizes.some((size) => !size.startsWith("blob "))) {
    throw new Error(
      "Cannot estimate worktree overlay size; inspect the repository objects and retry.",
    );
  }
  return {
    targetBytes,
    changedBytes: sizes.reduce((bytes, size) => bytes + allocatedBlobBytes(size.slice(5)), 0),
    requiresFullCheckout: false,
  };
}

/** Measure without following links; unreadable trees must never be counted as empty. */
export async function measureDirectoryTreeBytes(root: string, excludeGit = false): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return 0;
    }
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    if (excludeGit && entry.name === ".git") {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      total += await measureDirectoryTreeBytes(child, excludeGit);
    } else {
      try {
        total += (await fs.lstat(child)).size;
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
    }
  }
  return total;
}
