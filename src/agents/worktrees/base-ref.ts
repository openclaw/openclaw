import { commandError, runGit } from "./git.js";

type ResolvedWorktreeBase = {
  commit: string;
  gitOperand: string;
  recordRef: string;
  remote: boolean;
};

export class InvalidWorktreeBaseRefError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Worktree base ref does not resolve to a commit. Choose a local or remote branch and retry.",
      options,
    );
    this.name = "InvalidWorktreeBaseRefError";
  }
}

function invalidWorktreeBaseRef(command: string, result: Parameters<typeof commandError>[1]) {
  return new InvalidWorktreeBaseRefError({ cause: commandError(command, result) });
}

export async function resolveWorktreeBase(
  repoRoot: string,
  baseRef?: string,
  signal?: AbortSignal,
): Promise<ResolvedWorktreeBase> {
  if (baseRef) {
    const verified = await runGit(
      repoRoot,
      [
        "-c",
        "core.warnAmbiguousRefs=true",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${baseRef === "-" ? "@{-1}" : baseRef}^{commit}`,
      ],
      { signal },
    );
    signal?.throwIfAborted();
    const commit = verified.stdout.trim();
    if (verified.code !== 0 || !commit || commit.includes("\n") || verified.stderr.trim()) {
      throw invalidWorktreeBaseRef("git rev-parse --verify", verified);
    }
    // `worktree add -b` forwards its start point to `git branch`, which parses
    // options again without another `--`; pass the verified commit for dashed refs.
    const gitOperand = baseRef !== "-" && baseRef.startsWith("-") ? commit : baseRef;
    return { commit, gitOperand, recordRef: baseRef, remote: false };
  }
  const fetched = await runGit(repoRoot, ["fetch", "origin"], { signal });
  signal?.throwIfAborted();
  if (fetched.code === 0) {
    const remoteHead = await runGit(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
      const remoteRef = remoteHead.stdout.trim();
      const resolved = await resolveWorktreeBase(repoRoot, remoteRef, signal);
      return { ...resolved, remote: true };
    }
  }
  return await resolveWorktreeBase(repoRoot, "HEAD", signal);
}
