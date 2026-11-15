import fs from "node:fs/promises";
import path from "node:path";
import { requireGitCommandOutput } from "../../infra/git-exec.js";
import { readGitHead, resolveGitRefsBase } from "../../infra/git-root.js";
import { WorktreeRepositoryError } from "./errors.js";
import { findGitCheckoutRoot, runGit } from "./git.js";
import { resolveCheckoutRootFromRealPath } from "./repository-paths.js";
import type { ManagedWorktreeBranch, ManagedWorktreeBranchesResult } from "./types.js";

const BRANCH_INVENTORY_MAX_OUTPUT_BYTES = 256 * 1024;
const BRANCH_SUGGESTIONS_PER_KIND = 100;

type RepositoryBranchRef = {
  ref: string;
  branchName: string;
  branch: ManagedWorktreeBranch;
};

async function listRepositoryBranchRefs(
  repoRoot: string,
  patterns: string[],
  count: number,
): Promise<RepositoryBranchRef[]> {
  const result = await runGit(
    repoRoot,
    [
      "--no-optional-locks",
      "-c",
      "core.warnAmbiguousRefs=true",
      "for-each-ref",
      `--count=${count}`,
      "--sort=refname",
      "--format=%(refname)%00%(refname:short)",
      ...patterns,
    ],
    {
      timeoutMs: 1_500,
      maxOutputBytes: BRANCH_INVENTORY_MAX_OUTPUT_BYTES,
    },
  );
  const output = requireGitCommandOutput("git for-each-ref", result);
  const branches: RepositoryBranchRef[] = [];
  for (const line of output.trim().split("\n")) {
    const [ref, name] = line.split("\0");
    if (!ref || !name) {
      continue;
    }
    if (ref.startsWith("refs/heads/")) {
      branches.push({
        ref,
        branchName: ref.slice("refs/heads/".length),
        branch: { name, kind: "local" },
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const remoteRef = ref.slice("refs/remotes/".length);
      const slash = remoteRef.indexOf("/");
      const branchName = slash > 0 ? remoteRef.slice(slash + 1) : "";
      branches.push({ ref, branchName, branch: { name, kind: "remote" } });
    }
  }
  return branches;
}

export async function readRepositoryBranches(
  repoRoot: string,
  options: { includeRepositoryStatus?: boolean } = {},
): Promise<ManagedWorktreeBranchesResult> {
  let sourceRoot: string;
  let requested: string;
  try {
    requested = await fs.realpath(repoRoot).catch(() => {
      throw new Error(`repository does not exist: ${repoRoot}`);
    });
    if (options.includeRepositoryStatus && !(await fs.stat(requested)).isDirectory()) {
      return { branches: [], repositoryStatus: "unavailable" };
    }
    const candidate = findGitCheckoutRoot(requested);
    if (options.includeRepositoryStatus && !candidate) {
      return { branches: [], repositoryStatus: "not_git" };
    }
    const admitted = await resolveCheckoutRootFromRealPath(requested, repoRoot);
    sourceRoot = admitted.root;
  } catch (error) {
    if (options.includeRepositoryStatus) {
      // An unborn checkout supports direct sessions, but has no worktree base yet.
      if (error instanceof WorktreeRepositoryError && error.reason === "unborn") {
        return { branches: [], repositoryStatus: "not_git" };
      }
      return { branches: [], repositoryStatus: "unavailable" };
    }
    throw error;
  }
  const branches = new Map<string, RepositoryBranchRef>();
  let branchesUnavailable = false;
  for (const prefix of ["refs/remotes/", "refs/heads/"]) {
    try {
      const entries = await listRepositoryBranchRefs(
        sourceRoot,
        [prefix],
        BRANCH_SUGGESTIONS_PER_KIND,
      );
      for (const entry of entries) {
        if (entry.branchName && (entry.branch.kind !== "remote" || entry.branchName !== "HEAD")) {
          // Local branches win collisions with the same logical remote branch name.
          branches.set(entry.branchName, entry);
        }
      }
    } catch {
      branchesUnavailable = true;
    }
  }
  const remoteHead = await runGit(
    sourceRoot,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { timeoutMs: 1_500 },
  );
  const defaultRef = remoteHead.code === 0 ? remoteHead.stdout.trim() : undefined;
  const head = await runGit(sourceRoot, ["symbolic-ref", "--quiet", "HEAD"], { timeoutMs: 1_500 });
  const headRef = head.code === 0 ? head.stdout.trim() : undefined;
  branchesUnavailable ||= remoteHead.termination !== "exit" || head.termination !== "exit";
  const resolveBranch = async (ref: string | undefined) => {
    if (!ref) {
      return undefined;
    }
    const known = [...branches.values()].find((entry) => entry.ref === ref);
    if (known) {
      return known?.branchName && (known.branch.kind !== "remote" || known.branchName !== "HEAD")
        ? known
        : undefined;
    }
    try {
      // Patterns can match descendants; only the exact priority ref is eligible.
      return (await listRepositoryBranchRefs(sourceRoot, [ref], 1)).find(
        (entry) =>
          entry.ref === ref &&
          entry.branchName &&
          (entry.branch.kind !== "remote" || entry.branchName !== "HEAD"),
      );
    } catch {
      branchesUnavailable = true;
      return undefined;
    }
  };
  const localDefaultRef = defaultRef?.startsWith("refs/remotes/origin/")
    ? `refs/heads/${defaultRef.slice("refs/remotes/origin/".length)}`
    : undefined;
  // Priority refs must survive the inventory bound and use the same disambiguation.
  const defaultEntry = (await resolveBranch(localDefaultRef)) ?? (await resolveBranch(defaultRef));
  const headEntry = headRef === defaultEntry?.ref ? defaultEntry : await resolveBranch(headRef);
  for (const entry of [defaultEntry, headEntry]) {
    if (entry) {
      branches.set(entry.branchName, entry);
    }
  }
  const rank = (entry: RepositoryBranchRef) =>
    entry.ref === defaultEntry?.ref ? 0 : entry.ref === headEntry?.ref ? 1 : 2;
  const result: ManagedWorktreeBranchesResult = {
    branches: [...branches.values()]
      .toSorted((a, b) => rank(a) - rank(b) || a.branch.name.localeCompare(b.branch.name))
      .map((entry) => entry.branch),
    ...(defaultEntry ? { defaultBranch: defaultEntry.branch.name } : {}),
    ...(headEntry ? { headBranch: headEntry.branch.name } : {}),
    ...(branchesUnavailable ? { branchesUnavailable: true } : {}),
  };
  return {
    ...result,
    ...(options.includeRepositoryStatus ? { repositoryStatus: "git" } : {}),
  };
}

/** Worker-only observation paths keep ref watching independent of checkout/object inventories. */
export async function readRepositoryBranchSnapshot(
  repoRoot: string,
  options: { includeRepositoryStatus?: boolean } = {},
) {
  const result = await readRepositoryBranches(repoRoot, options);
  try {
    const head = readGitHead(repoRoot);
    if (head) {
      const gitDir = path.dirname(head.headPath);
      const root = findGitCheckoutRoot(repoRoot) ?? repoRoot;
      return {
        ...result,
        observation: { root, gitDir, commonDir: resolveGitRefsBase(head.headPath) },
      };
    }
  } catch {
    // Unavailable metadata is already represented by the discovery result.
  }
  return result;
}
