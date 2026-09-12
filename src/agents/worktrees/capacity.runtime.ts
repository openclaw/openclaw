import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { requireGitCommandOutput } from "../../infra/git-exec.js";
import { requireGit, requireGitBuffer, runGit, WORKTREE_CHECKOUT_TIMEOUT_MS } from "./git.js";

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

export async function estimateWorktreeGitBytes(repoRoot: string, ref: string): Promise<number> {
  const commit = await requireGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref === "-" ? "@{-1}" : ref}^{commit}`,
  ]);
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
    await requireGit(
      repoRoot,
      ["fetch", remote, "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--stdin"],
      { input: Buffer.from(`${missing.join("\n")}\n`), timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS },
    );
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
      const value = Number(size);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          "Cannot estimate worktree checkout size; inspect the repository objects and retry.",
        );
      }
      bytes += Math.max(4096, Math.ceil(value / 4096) * 4096);
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

/** Measure without following links; unreadable trees must never be counted as empty. */
export async function directorySizeBytes(root: string, excludeGit = false): Promise<number> {
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
      total += await directorySizeBytes(child, excludeGit);
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
