import { requireGitCommandOutput, type GitCommandOptions } from "../../infra/git-exec.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { requireGit, requireGitBuffer, runGit, WORKTREE_CHECKOUT_TIMEOUT_MS } from "./git.js";

const log = createSubsystemLogger("agents/worktrees");

export async function missingCommitObjects(
  repoRoot: string,
  commit: string,
  options: GitCommandOptions = {},
): Promise<string[]> {
  const objects = (
    await requireGitBuffer(
      repoRoot,
      ["rev-list", "--objects", "--missing=print", "--no-object-names", "--max-count=1", commit],
      { ...options, env: { ...options.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" } },
    )
  ).toString("utf8");
  return objects
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1));
}

async function readOptionalGitConfig(
  repoRoot: string,
  args: string[],
  options: GitCommandOptions,
): Promise<string> {
  const result = await runGit(repoRoot, ["config", ...args], options);
  return result.termination === "exit" && result.code === 1
    ? ""
    : requireGitCommandOutput(`git config ${args.join(" ")}`, result).trim();
}

export function missingObjectsError(commit: string, count: number): Error {
  return new Error(
    `Repository is missing ${count} objects for ${commit}; fetch or repair the clone.`,
  );
}

export async function hydrateCommitObjects(
  repoRoot: string,
  commit: string,
  knownMissing?: string[],
  options: GitCommandOptions = {},
): Promise<void> {
  const missing = knownMissing ?? (await missingCommitObjects(repoRoot, commit, options));
  if (missing.length > 0) {
    const remote =
      (await readOptionalGitConfig(repoRoot, ["--get", "extensions.partialclone"], options)) ||
      /^remote\.(.+)\.promisor true$/m.exec(
        await readOptionalGitConfig(
          repoRoot,
          ["--bool", "--get-regexp", "^remote\\..*\\.promisor$"],
          options,
        ),
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
        "--no-prune",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--stdin",
      ],
      {
        ...options,
        input: Buffer.from(`${missing.join("\n")}\n`),
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      },
    ).catch((error: unknown) => {
      log.warn(
        `worktree prefetch failed: ${missing.length} missing objects for ${commit}; check the promisor remote.`,
      );
      throw error;
    });
  }
}
