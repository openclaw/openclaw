import fs from "node:fs/promises";
import { requireGitCommandOutput } from "../../infra/git-exec.js";
import { gitFilesystemEnvironmentRevision } from "../../infra/git-worker-context.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { WorktreeRepositoryError } from "./errors.js";
import { findGitCheckoutRoot, runGit } from "./git.js";
import { resolveCheckoutRootFromRealPath } from "./repository-paths.js";
import type { ManagedWorktreeBranch, ManagedWorktreeBranchesResult } from "./types.js";

const BRANCH_INVENTORY_MAX_OUTPUT_BYTES = 256 * 1024;
const BRANCH_SUGGESTIONS_PER_KIND = 100;
const BRANCH_INVENTORY_FRESHNESS_MS = 30_000;

type RepositoryBranchRef = {
  ref: string;
  branchName: string;
  branch: ManagedWorktreeBranch;
  symbolicRef?: string;
  current?: boolean;
};

// Suggestions may lag repository changes until the next bounded refresh.
// Creation still validates the selected ref through Git before changing any checkout.
const branchInventories = new Map<
  string,
  {
    revision: string;
    requested: string;
    refreshedAt: number;
    result: ManagedWorktreeBranchesResult;
  }
>();

async function listRepositoryBranchRefs(
  repoRoot: string,
  patterns: string[],
  count?: number,
): Promise<RepositoryBranchRef[]> {
  const result = await runGit(
    repoRoot,
    [
      "-c",
      "core.warnAmbiguousRefs=true",
      "for-each-ref",
      ...(count === undefined ? [] : [`--count=${count}`]),
      "--sort=refname",
      count === undefined
        ? "--format=%(refname)%00%(refname:short)%00%(symref)%00%(HEAD)"
        : "--format=%(refname)%00%(refname:short)",
      ...patterns,
    ],
    {
      maxOutputBytes: BRANCH_INVENTORY_MAX_OUTPUT_BYTES,
      terminateOnOutputLimit: count === undefined,
    },
  );
  const output = requireGitCommandOutput("git for-each-ref", result);
  const branches: RepositoryBranchRef[] = [];
  for (const line of output.trim().split("\n")) {
    const [ref, name, symbolicRef, head] = line.split("\0");
    const metadata = { symbolicRef: symbolicRef || undefined, current: head === "*" };
    if (!ref || !name) {
      continue;
    }
    if (ref.startsWith("refs/heads/")) {
      branches.push({
        ref,
        ...metadata,
        branchName: ref.slice("refs/heads/".length),
        branch: { name, kind: "local" },
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const remoteRef = ref.slice("refs/remotes/".length);
      const slash = remoteRef.indexOf("/");
      const branchName = slash > 0 ? remoteRef.slice(slash + 1) : "";
      branches.push({ ref, branchName, ...metadata, branch: { name, kind: "remote" } });
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
  const environment = gitFilesystemEnvironmentRevision();
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
    const cached = candidate ? branchInventories.get(candidate) : undefined;
    if (candidate && environment !== undefined) {
      if (
        cached?.requested === requested &&
        environment === cached.revision &&
        Date.now() - cached.refreshedAt < BRANCH_INVENTORY_FRESHNESS_MS
      ) {
        branchInventories.delete(candidate);
        branchInventories.set(candidate, cached);
        return {
          ...cached.result,
          ...(options.includeRepositoryStatus ? { repositoryStatus: "git" } : {}),
        };
      }
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
  branchInventories.delete(sourceRoot);
  // One fresh inventory carries current/default refs as well as strict selection names.
  // Fall back to count-bounded queries when a large repository exceeds the byte guard.
  let inventory: RepositoryBranchRef[] | undefined;
  try {
    inventory = await listRepositoryBranchRefs(sourceRoot, ["refs/heads/", "refs/remotes/"]);
  } catch {
    inventory = undefined;
  }
  const branches = new Map<string, RepositoryBranchRef>();
  let branchesUnavailable = false;
  for (const prefix of ["refs/remotes/", "refs/heads/"]) {
    try {
      const entries = inventory
        ? inventory
            .filter((entry) => entry.ref.startsWith(prefix))
            .slice(0, BRANCH_SUGGESTIONS_PER_KIND)
        : await listRepositoryBranchRefs(sourceRoot, [prefix], BRANCH_SUGGESTIONS_PER_KIND);
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
  let defaultRef: string | undefined;
  let headRef: string | undefined;
  if (inventory) {
    defaultRef = inventory.find((entry) => entry.ref === "refs/remotes/origin/HEAD")?.symbolicRef;
    headRef = inventory.find((entry) => entry.current)?.ref;
  } else {
    const remoteHead = await runGit(sourceRoot, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ]);
    defaultRef = remoteHead.code === 0 ? remoteHead.stdout.trim() : undefined;
    const head = await runGit(sourceRoot, ["symbolic-ref", "--quiet", "HEAD"]);
    headRef = head.code === 0 ? head.stdout.trim() : undefined;
  }
  const resolveBranch = async (ref: string | undefined) => {
    if (!ref) {
      return undefined;
    }
    const known = (inventory ?? [...branches.values()]).find((entry) => entry.ref === ref);
    if (known || inventory) {
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
  const headEntry = await resolveBranch(headRef);
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
  if (!branchesUnavailable && environment !== undefined) {
    branchInventories.set(sourceRoot, {
      revision: environment,
      requested,
      refreshedAt: Date.now(),
      result,
    });
    pruneMapToMaxSize(branchInventories, 64);
  }
  return {
    ...result,
    ...(options.includeRepositoryStatus ? { repositoryStatus: "git" } : {}),
  };
}
