import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { normalizeGitPathForFilesystem } from "../../infra/git-exec.js";
import { withGitProcessOperation } from "../../process/spawn-diagnostics.js";
import { WorktreeRepositoryError } from "./errors.js";
import { commandError, insideGitCheckout, resolveGitRepositoryPaths, runGit } from "./git.js";
import { timeWorktreePreparationPhase } from "./preparation-timing.js";

export async function resolveCheckoutRootFromRealPath(
  requested: string,
  requestedLabel: string,
): Promise<{ root: string; commit: string }> {
  const rootResult = await runGit(requested, [
    "rev-parse",
    "--show-toplevel",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (rootResult.code !== 0) {
    if (rootResult.termination === "exit" && rootResult.stdout.trim()) {
      const head = await runGit(requested, ["symbolic-ref", "--quiet", "HEAD"]);
      const ref = head.stdout.trim();
      if (
        head.termination === "exit" &&
        head.code === 0 &&
        !head.stderr.trim() &&
        ref.startsWith("refs/heads/")
      ) {
        const target = await runGit(requested, ["show-ref", "--verify", "--quiet", ref]);
        if (target.termination === "exit" && target.code === 1 && !target.stderr.trim()) {
          throw new WorktreeRepositoryError(
            `git checkout has no commits: ${requestedLabel}. Create an initial commit, then retry.`,
            { reason: "unborn" },
          );
        }
      }
    }
    if (insideGitCheckout(requested)) {
      throw new Error(
        `Git metadata is unavailable for ${requested}; checkout preserved. Restore the original repository metadata, then use git worktree repair from that repository. Do not recreate its index or delete the checkout to bypass recovery.`,
      );
    }
    throw new WorktreeRepositoryError(`not a git checkout: ${requestedLabel}`);
  }
  const output = rootResult.stdout.replace(/\n$/, "");
  const separator = output.lastIndexOf("\n");
  const root = separator < 0 ? "" : output.slice(0, separator);
  if (!root) {
    throw new WorktreeRepositoryError(`not a git checkout: ${requestedLabel}`);
  }
  return {
    root: await fs.realpath(normalizeGitPathForFilesystem(root)),
    commit: output.slice(separator + 1),
  };
}

export type ResolvedRepository = {
  repoRoot: string;
  sourceRoot: string;
  commonDir: string;
  originUrl: string;
  fingerprint: string;
};

async function resolveRepositoryPathsFromRealPath(requested: string, requestedLabel: string) {
  const { root: sourceRoot } = await resolveCheckoutRootFromRealPath(requested, requestedLabel);
  return { sourceRoot, ...(await resolveGitRepositoryPaths(sourceRoot)) };
}

export async function resolveRepositoryFromRealPath(
  requested: string,
  requestedLabel: string,
): Promise<ResolvedRepository> {
  return withGitProcessOperation(
    "repository.identities",
    async () => {
      const { sourceRoot, canonicalRoot, commonDir } = await resolveRepositoryPathsFromRealPath(
        requested,
        requestedLabel,
      );
      const origin = await runGit(canonicalRoot, ["config", "--get", "remote.origin.url"]);
      if (origin.termination !== "exit" || (origin.code !== 0 && origin.code !== 1)) {
        throw commandError("git config --get remote.origin.url", origin);
      }
      const originUrl = origin.code === 0 ? origin.stdout.trim() : "";
      const fingerprint = createHash("sha256")
        .update(`${commonDir}\n${originUrl}`)
        .digest("hex")
        .slice(0, 16);
      return { repoRoot: canonicalRoot, sourceRoot, commonDir, originUrl, fingerprint };
    },
    "default",
  );
}

async function withRepositoryRealPath<T>(
  repoRoot: string,
  read: (requested: string, requestedLabel: string) => Promise<T>,
): Promise<T> {
  return await timeWorktreePreparationPhase("repository", async () => {
    const requested = await fs.realpath(repoRoot).catch(() => {
      throw new Error(`repository does not exist: ${repoRoot}`);
    });
    return await read(requested, repoRoot);
  });
}

export function resolveRepository(repoRoot: string): Promise<ResolvedRepository> {
  return withRepositoryRealPath(repoRoot, resolveRepositoryFromRealPath);
}

export function resolveRepositoryPaths(repoRoot: string) {
  return withGitProcessOperation(
    "repository.identities",
    () => withRepositoryRealPath(repoRoot, resolveRepositoryPathsFromRealPath),
    "default",
  );
}

export async function resolveRepositoryIdentity(repoRoot: string) {
  const resolved = await resolveRepository(repoRoot);
  return {
    checkoutRoot: resolved.sourceRoot,
    repoRoot: resolved.repoRoot,
    originUrl: resolved.originUrl,
    fingerprint: resolved.fingerprint,
  };
}
