import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { createGitCommandError, requireGitCommandOutput } from "../../infra/git-exec.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { rawPathStat } from "./git-path-inventory.js";
import type { GitWorktreeOperations } from "./git-worktree-operations.js";
import {
  requireGit,
  requireGitBuffer,
  runGit,
  runGitBuffered,
  WORKTREE_CHECKOUT_TIMEOUT_MS,
} from "./git.js";

const log = createSubsystemLogger("agents/worktrees");

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
    // --refetch hints auto-maintenance to repack (gc.autoPackLimit=1); that repack must
    // never run inside the allocation lease.
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
    ).catch((error: unknown) => {
      log.warn(
        `worktree prefetch failed: ${missing.length} missing objects for ${commit}; check the promisor remote.`,
      );
      throw error;
    });
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
// idles out or the Gateway closes it. Default bases reuse hydration by immutable commit;
// explicit refs without a preparation key still recheck object availability.
type CheckoutSize = {
  bytes: number;
  transition?: { base: string; changedBytes: number; requiresFullCheckout: boolean };
};
type CheckoutSizeFact = CheckoutSize & {
  repositoryKey: string;
  commit: string;
  preparationKey?: string;
};
const checkoutSizeFacts = new Map<string, CheckoutSizeFact>();
const MAX_CHECKOUT_SIZE_FACTS = 32;

async function commitObjectBytes(
  repoRoot: string,
  commit: string,
  replacementRefBase: string | undefined,
  preparationKey?: string,
): Promise<CheckoutSize> {
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
  let repositoryKey: string | undefined;
  let cached: CheckoutSizeFact | undefined;
  let previous: CheckoutSizeFact | undefined;
  if (replacements === "") {
    const canonicalRoot = await fs.realpath(repoRoot);
    const identity = await fs.stat(canonicalRoot);
    repositoryKey = JSON.stringify([canonicalRoot, identity.dev, identity.ino]);
    cacheKey = JSON.stringify([canonicalRoot, identity.dev, identity.ino, commit]);
    cached = checkoutSizeFacts.get(cacheKey);
    if (cached && preparationKey && cached.preparationKey === preparationKey) {
      return cached;
    }
    if (!cached) {
      for (const fact of checkoutSizeFacts.values()) {
        if (fact.repositoryKey === repositoryKey) {
          previous = fact;
        }
      }
    }
  }

  await hydrateCommitObjects(repoRoot, commit);
  if (cached && cacheKey) {
    const refreshed = { ...cached, preparationKey };
    checkoutSizeFacts.set(cacheKey, refreshed);
    return refreshed;
  }

  try {
    let size = previous ? await advanceCheckoutSize(repoRoot, previous, commit) : undefined;
    if (!size) {
      const sizes = (
        await requireGitBuffer(
          repoRoot,
          ["ls-tree", "-r", "--format=%(objectsize)", commit, "--"],
          {
            env: { GIT_NO_LAZY_FETCH: "1" },
          },
        )
      ).toString("utf8");
      let bytes = 0;
      for (const value of sizes.split("\n")) {
        if (value && value !== "-") {
          bytes += allocatedBlobBytes(value);
        }
      }
      size = { bytes };
    }
    if (cacheKey && repositoryKey) {
      checkoutSizeFacts.set(cacheKey, { ...size, repositoryKey, commit, preparationKey });
      pruneMapToMaxSize(checkoutSizeFacts, MAX_CHECKOUT_SIZE_FACTS);
    }
    return size;
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
  preparationKey?: string,
): Promise<number> {
  const commit = await resolveCommit(repoRoot, ref);
  return (await commitObjectBytes(repoRoot, commit, replacementRefBase, preparationKey)).bytes;
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
  if (target !== base) {
    await hydrateCommitObjects(repoRoot, base);
  }
  const targetSize = await commitObjectBytes(repoRoot, target, replacementRefBase);
  const targetBytes = targetSize.bytes;
  if (target === base) {
    return { targetBytes, changedBytes: 0, requiresFullCheckout: false };
  }
  const prepared = targetSize.transition;
  if (prepared?.base === base) {
    return {
      targetBytes,
      changedBytes: prepared.requiresFullCheckout ? targetBytes : prepared.changedBytes,
      requiresFullCheckout: prepared.requiresFullCheckout,
    };
  }
  const diff = await readCheckoutDiff(repoRoot, base, target);
  if (diff.termination === "output-limit") {
    // A large diff cannot justify a partial allocation estimate or rule out
    // attribute changes. Keep the buffer bounded and materialize the full target.
    return { targetBytes, changedBytes: targetBytes, requiresFullCheckout: true };
  }
  if (diff.termination !== "exit" || diff.code !== 0) {
    throw createGitCommandError("git diff-tree", diff);
  }
  const { after, checkoutAttributesChanged } = parseCheckoutDiff(diff.stdout);
  // read-tree does not rewrite unchanged paths when attributes change.
  if (checkoutAttributesChanged) {
    return { targetBytes, changedBytes: targetBytes, requiresFullCheckout: true };
  }
  const sizes = await readCheckoutBlobSizes(repoRoot, after);
  if (!sizes) {
    throw new Error(
      "Cannot estimate worktree overlay size; inspect the repository diff and retry.",
    );
  }
  return {
    targetBytes,
    changedBytes: sizes.reduce((bytes, size) => bytes + size, 0),
    requiresFullCheckout: false,
  };
}

function readCheckoutDiff(repoRoot: string, base: string, target: string) {
  return runGitBuffered(
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
}

function parseCheckoutDiff(output: Buffer) {
  const changes = output.toString("utf8").split("\0");
  if (changes.at(-1) !== "" || changes.length % 2 !== 1) {
    throw new Error(
      "Cannot estimate worktree overlay size; inspect the repository diff and retry.",
    );
  }
  const before: string[] = [];
  const after: string[] = [];
  let checkoutAttributesChanged = false;
  for (let offset = 0; offset < changes.length - 1; offset += 2) {
    // Count every changed path, even when multiple paths share a blob.
    const metadata = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) [AMDT]$/u.exec(
      changes[offset]!,
    );
    if (!metadata || changes[offset + 1] === undefined) {
      throw new Error(
        "Cannot estimate worktree overlay size; inspect the repository diff and retry.",
      );
    }
    const changedPath = changes[offset + 1]!;
    checkoutAttributesChanged ||=
      changedPath === ".gitattributes" || changedPath.endsWith("/.gitattributes");
    if (metadata[1] !== "000000" && metadata[1] !== "160000") {
      before.push(metadata[3]!);
    }
    if (metadata[2] !== "000000" && metadata[2] !== "160000") {
      after.push(metadata[4]!);
    }
  }
  return { before, after, checkoutAttributesChanged };
}

async function readCheckoutBlobSizes(repoRoot: string, blobs: string[]) {
  if (blobs.length === 0) {
    return [];
  }
  const result = await runGitBuffered(
    repoRoot,
    ["cat-file", "--batch-check=%(objecttype) %(objectsize)"],
    {
      input: Buffer.from(`${blobs.join("\n")}\n`),
      env: { GIT_NO_LAZY_FETCH: "1" },
    },
  );
  if (unavailableCheckoutSize(result)) {
    return undefined;
  }
  if (result.termination !== "exit" || result.code !== 0) {
    throw createGitCommandError("git cat-file", result);
  }
  const sizes = result.stdout.toString("utf8").trimEnd().split("\n");
  if (sizes.length !== blobs.length || sizes.some((size) => !size.startsWith("blob "))) {
    return undefined;
  }
  return sizes.map((size) => allocatedBlobBytes(size.slice(5)));
}

function unavailableCheckoutSize(result: Awaited<ReturnType<typeof runGitBuffered>>) {
  return (
    result.termination === "output-limit" || (result.termination === "exit" && result.code === 128)
  );
}

async function advanceCheckoutSize(
  repoRoot: string,
  previous: CheckoutSizeFact,
  commit: string,
): Promise<CheckoutSize | undefined> {
  // The worker retains totals, not old objects. Collected history falls back to
  // sizing the hydrated target; it must never fetch history just to reuse a total.
  const diff = await readCheckoutDiff(repoRoot, previous.commit, commit);
  if (unavailableCheckoutSize(diff)) {
    return undefined;
  }
  if (diff.termination !== "exit" || diff.code !== 0) {
    throw createGitCommandError("git diff-tree", diff);
  }
  const { before, after, checkoutAttributesChanged } = parseCheckoutDiff(diff.stdout);
  const sizes = await readCheckoutBlobSizes(repoRoot, [...before, ...after]);
  if (!sizes) {
    return undefined;
  }
  let bytes = previous.bytes;
  let changedBytes = 0;
  for (const [index, size] of sizes.entries()) {
    if (index < before.length) {
      bytes -= size;
    } else {
      bytes += size;
      changedBytes += size;
    }
  }
  return {
    bytes,
    transition: {
      base: previous.commit,
      changedBytes,
      requiresFullCheckout: checkoutAttributesChanged,
    },
  };
}

/** Measure without following links; unreadable trees must never be counted as empty. */
export async function measureDirectoryTreeBytes(root: string): Promise<number> {
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
    if (entry.name === ".git") {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await measureDirectoryTreeBytes(child);
    } else {
      total += (await rawPathStat(child))?.size ?? 0;
    }
  }
  return total;
}
