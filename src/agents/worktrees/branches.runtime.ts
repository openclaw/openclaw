import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeGitPathForFilesystem, requireGitCommandOutput } from "../../infra/git-exec.js";
import {
  readGitHead,
  readGitMetadataDirectories,
  readGitMetadataFile,
} from "../../infra/git-root.js";
import { gitFilesystemEnvironmentRevision } from "../../infra/git-worker-context.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { WorktreeRepositoryError } from "./errors.js";
import { findGitCheckoutRoot, insideGitCheckout, runGit } from "./git.js";
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

// Git proves commit integrity; each reuse proves that its inputs and object storage are unchanged.
const branchInventories = new Map<
  string,
  {
    revision: string;
    requested: string;
    environment: string;
    configPaths: string[];
    result: ManagedWorktreeBranchesResult;
  }
>();

function branchInventoryRevision(
  repoRoot: string,
  requested: string,
  configPaths: string[],
): { revision: string; head: string } | undefined {
  const environment = gitFilesystemEnvironmentRevision();
  if (environment === undefined || configPaths.some((file) => !path.isAbsolute(file))) {
    return undefined;
  }
  try {
    const stamps: [string, string][] = [];
    const stamp = (file: string) => {
      const stat = fsSync.lstatSync(file, { bigint: true, throwIfNoEntry: false });
      // Streams have no content revision; symlink targets can change independently.
      if ((stat && !stat.isFile() && !stat.isDirectory()) || stamps.length >= 1024) {
        throw new Error("Uncacheable ref inventory");
      }
      stamps.push([
        file,
        stat
          ? `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
          : "missing",
      ]);
      return stat;
    };
    stamp(path.join(repoRoot, ".git"));
    const directories = readGitMetadataDirectories(repoRoot);
    if (!directories) {
      return undefined;
    }
    const { gitDir, commonDir: common } = directories;
    for (let directory = requested; directory !== repoRoot; directory = path.dirname(directory)) {
      if (directory === path.dirname(directory) || !stamp(directory)?.isDirectory()) {
        return undefined;
      }
    }
    const head = readGitHead(repoRoot, { maxDepth: 1 })?.value;
    const objects = path.join(common, "objects");
    if (
      !head ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head) ||
      ["reftable", "refs/replace", "info/grafts", "objects/info/alternates"].some((name) =>
        fsSync.existsSync(path.join(common, name)),
      ) ||
      (fsSync.existsSync(path.join(common, "packed-refs")) &&
        readGitMetadataFile(path.join(common, "packed-refs"), Number.MAX_SAFE_INTEGER)
          .toString("utf8")
          .includes("refs/replace/"))
    ) {
      return undefined;
    }
    for (const file of [
      repoRoot,
      gitDir,
      common,
      path.join(gitDir, "HEAD"),
      path.join(gitDir, "commondir"),
      path.join(common, "packed-refs"),
      path.join(common, "shallow"),
      objects,
      path.join(objects, head.slice(0, 2)),
      path.join(objects, head.slice(0, 2), head.slice(2)),
    ]) {
      stamp(file);
    }
    for (const file of [
      ...configPaths,
      path.join(common, "config"),
      path.join(gitDir, "config.worktree"),
    ]) {
      const stat = stamp(file);
      if (
        stat &&
        (!stat.isFile() ||
          stat.size > 1024 * 1024 ||
          /include/iu.test(
            readGitMetadataFile(file)
              .toString("utf8")
              .replace(/\\\r?\n/gu, ""),
          ))
      ) {
        return undefined;
      }
    }
    const packs = path.join(objects, "pack");
    if (stamp(packs)?.isDirectory()) {
      for (const name of fsSync.readdirSync(packs).toSorted()) {
        if (name.endsWith(".promisor") || !stamp(path.join(packs, name))?.isFile()) {
          return undefined;
        }
      }
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
    return { revision: JSON.stringify([environment, head, stamps]), head };
  } catch {
    return undefined;
  }
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
  let requested: string;
  let snapshot: ReturnType<typeof branchInventoryRevision>;
  let configPaths: string[] = [];
  const environment = gitFilesystemEnvironmentRevision();
  try {
    requested = await fs.realpath(repoRoot).catch(() => {
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
    const candidate = findGitCheckoutRoot(requested);
    const cached = candidate ? branchInventories.get(candidate) : undefined;
    if (candidate && environment !== undefined) {
      if (cached?.environment === environment) {
        configPaths = cached.configPaths;
      } else {
        // Git owns system/global config discovery, including files not created yet.
        const variables = await runGit(requested, ["var", "-l"]);
        if (variables.code === 0) {
          configPaths = [
            ...variables.stdout.matchAll(/^GIT_CONFIG_(?:SYSTEM|GLOBAL)=(.+)$/gmu),
          ].map((match) => normalizeGitPathForFilesystem(match[1]!));
        }
      }
      snapshot = configPaths.length
        ? branchInventoryRevision(candidate, requested, configPaths)
        : undefined;
      if (cached?.requested === requested && snapshot?.revision === cached.revision) {
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
    // A tag HEAD can peel through other loose objects; that graph stays Git-owned.
    if (candidate !== sourceRoot || snapshot?.head !== admitted.commit) {
      snapshot = undefined;
    }
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
  // Never publish under a newer revision if refs changed while Git was running.
  if (
    !branchesUnavailable &&
    environment !== undefined &&
    snapshot !== undefined &&
    snapshot.revision === branchInventoryRevision(sourceRoot, requested, configPaths)?.revision
  ) {
    branchInventories.set(sourceRoot, {
      revision: snapshot.revision,
      requested,
      environment,
      configPaths,
      result,
    });
    pruneMapToMaxSize(branchInventories, 64);
  }
  return {
    ...result,
    ...(options.includeRepositoryStatus ? { repositoryStatus: "git" } : {}),
  };
}
