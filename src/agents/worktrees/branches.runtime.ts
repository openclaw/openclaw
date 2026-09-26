import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { requireGitCommandOutput } from "../../infra/git-exec.js";
import { readGitMetadataPrefix, resolveGitRefsBase } from "../../infra/git-root.js";
import { canReadGitFilesystemRefs } from "../../infra/git-worker-context.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { WorktreeRepositoryError } from "./errors.js";
import { insideGitCheckout, runGit } from "./git.js";
import { resolveCheckoutRootFromRealPath } from "./repository-paths.js";
import type { ManagedWorktreeBranch, ManagedWorktreeBranchesResult } from "./types.js";

const BRANCH_INVENTORY_MAX_OUTPUT_BYTES = 256 * 1024;
const BRANCH_SUGGESTIONS_PER_KIND = 100;

type RepositoryBranchRef = {
  ref: string;
  branchName: string;
  branch: ManagedWorktreeBranch;
  symbolicRef?: string;
  current?: boolean;
};

// Worker-owned, bounded snapshots; checkout validation remains live on every read.
const branchInventories = new Map<string, { revision: string; refs: RepositoryBranchRef[] }>();

function branchInventoryRevision(repoRoot: string): string | undefined {
  if (!canReadGitFilesystemRefs()) {
    return undefined;
  }
  try {
    const stamps: string[] = [];
    const stamp = (file: string) => {
      const stat = fsSync.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (stat?.isSymbolicLink() || stamps.length >= 1024) {
        throw new Error("Uncacheable ref inventory");
      }
      stamps.push(
        file,
        stat
          ? `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
          : "missing",
      );
      return stat;
    };
    const marker = path.join(repoRoot, ".git");
    const markerStat = stamp(marker);
    const pointer =
      markerStat?.isFile() && markerStat.size <= 4096n
        ? /^gitdir: (.+)\r?\n?$/.exec(readGitMetadataPrefix(marker, 4096))?.[1]?.trim()
        : undefined;
    const gitDir = markerStat?.isDirectory()
      ? marker
      : pointer
        ? path.resolve(repoRoot, pointer)
        : undefined;
    if (!gitDir) {
      return undefined;
    }
    const head = path.join(gitDir, "HEAD");
    const common = resolveGitRefsBase(head);
    if (fsSync.existsSync(path.join(common, "reftable"))) {
      return undefined;
    }
    for (const file of [
      head,
      path.join(gitDir, "commondir"),
      path.join(common, "packed-refs"),
      path.join(common, "config"),
    ]) {
      stamp(file);
    }
    const visit = (directory: string, depth = 0) => {
      if (depth > 32 || !stamp(directory)?.isDirectory()) {
        throw new Error("Uncacheable ref directory");
      }
      for (const name of fsSync.readdirSync(directory).toSorted()) {
        const file = path.join(directory, name);
        if (stamp(file)?.isDirectory()) {
          visit(file, depth + 1);
        }
      }
    };
    // Tags and other namespaces also affect Git's strict short-name disambiguation.
    visit(path.join(common, "refs"));
    const worktreeRefs = path.join(gitDir, "refs");
    if (common !== gitDir && stamp(worktreeRefs)?.isDirectory()) {
      visit(worktreeRefs);
    }
    return JSON.stringify(stamps);
  } catch {
    return undefined;
  }
}

async function readBranchInventory(repoRoot: string): Promise<RepositoryBranchRef[]> {
  const revision = branchInventoryRevision(repoRoot);
  const cached = branchInventories.get(repoRoot);
  branchInventories.delete(repoRoot);
  if (revision !== undefined && cached?.revision === revision) {
    branchInventories.set(repoRoot, cached);
    return cached.refs;
  }
  const refs = await listRepositoryBranchRefs(repoRoot, ["refs/heads/", "refs/remotes/"]);
  // A writer racing the Git process must not publish a snapshot under its newer revision.
  if (revision !== undefined && revision === branchInventoryRevision(repoRoot)) {
    branchInventories.set(repoRoot, { revision, refs });
    pruneMapToMaxSize(branchInventories, 64);
  }
  return refs;
}

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
  try {
    const requested = await fs.realpath(repoRoot).catch(() => {
      throw new Error(`repository does not exist: ${repoRoot}`);
    });
    if (options.includeRepositoryStatus) {
      if (!(await fs.stat(requested)).isDirectory()) {
        return { branches: [], repositoryStatus: "unavailable" };
      }
      if (!insideGitCheckout(requested)) {
        return { branches: [], repositoryStatus: "not_git" };
      }
    }
    // Ref discovery needs this checkout's HEAD, not allocation identity or a
    // full inventory of sibling worktrees rooted at the primary checkout.
    sourceRoot = await resolveCheckoutRootFromRealPath(requested, repoRoot);
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
  // One fresh inventory carries current/default refs as well as strict selection names.
  // Fall back to count-bounded queries when a large repository exceeds the byte guard.
  let inventory: RepositoryBranchRef[] | undefined;
  try {
    inventory = await readBranchInventory(sourceRoot);
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
  return {
    branches: [...branches.values()]
      .toSorted((a, b) => rank(a) - rank(b) || a.branch.name.localeCompare(b.branch.name))
      .map((entry) => entry.branch),
    ...(defaultEntry ? { defaultBranch: defaultEntry.branch.name } : {}),
    ...(headEntry ? { headBranch: headEntry.branch.name } : {}),
    ...(options.includeRepositoryStatus ? { repositoryStatus: "git" as const } : {}),
    ...(branchesUnavailable ? { branchesUnavailable: true } : {}),
  };
}
