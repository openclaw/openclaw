import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  GitHubPublicationKnownFailure,
  GitHubPublicationWorkflowChangesError,
} from "./github-publication-failure.js";
import {
  TREE_LISTING_MAX_OUTPUT_BYTES,
  gitHubPublicationObjectSha as objectSha,
  type runPublicationCommand,
} from "./github-publication-git-transport.js";
import type { GitHubPublicationRequesterPolicy } from "./github-publication-requester.js";
import type { GitHubRepositoryPublicationSnapshot } from "./github-repository-publication-snapshot.js";

const workflowDirectory = ".github/workflows/";

export function assertGitHubPublicationWorkflowChangesAllowed(
  requester: GitHubPublicationRequesterPolicy,
): void {
  requester.assertCurrent();
  if (
    !roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.write"],
      allowedScopes: requester.snapshot.scopes,
    })
  ) {
    throw new GitHubPublicationWorkflowChangesError();
  }
}

function isGitHubPublicationWorkflowPath(file: string): boolean {
  return (
    file.startsWith(workflowDirectory) &&
    /^[^/]+\.ya?ml$/iu.test(file.slice(workflowDirectory.length))
  );
}

/** Full-authority publishers need no extra GitHub tree reads; restricted requests prove their delta. */
export async function prepareGitHubPublicationWorkflowGuard(
  assertWorkflowChangesAllowed: () => void,
  hasWorkflowChanges: () => Promise<boolean>,
): Promise<() => void> {
  try {
    assertWorkflowChangesAllowed();
  } catch (error) {
    if (!(error instanceof GitHubPublicationWorkflowChangesError) || (await hasWorkflowChanges())) {
      throw error;
    }
    return () => {};
  }
  return assertWorkflowChangesAllowed;
}

type WorkflowTree = ReadonlyMap<string, string>;

/** Only an unchanged published definition or an unambiguous target-only update is exempt. */
async function hasUnapprovedGitHubPublicationWorkflowChanges(params: {
  before: WorkflowTree;
  accepted: WorkflowTree;
  readUpstream: () => Promise<
    | {
        ancestor: WorkflowTree;
        sourceAncestor: WorkflowTree;
        source: WorkflowTree;
        target: WorkflowTree;
      }
    | undefined
  >;
}): Promise<boolean> {
  const changed = [...new Set([...params.before.keys(), ...params.accepted.keys()])].filter(
    (file) => params.before.get(file) !== params.accepted.get(file),
  );
  if (!changed.length) {
    return false;
  }
  const upstream = await params.readUpstream();
  // Absence is a value too: additions, deletions, renames and mode changes all
  // follow the same rule. Never overwrite a branch-owned change just because
  // the accepted definition matches main (including a revert to the old base).
  // The accepted source and the preceding publication are distinct baselines.
  return changed.some(
    (file) =>
      !upstream ||
      params.before.get(file) !== upstream.ancestor.get(file) ||
      upstream.source.get(file) !== upstream.sourceAncestor.get(file) ||
      params.accepted.get(file) !== upstream.target.get(file),
  );
}

type TreeEntry = { path: string; mode: string; sha: string };

function unavailableWorkflowTree() {
  return new GitHubPublicationKnownFailure("GitHub workflow definitions could not be verified.", {
    code: "unavailable",
    nextAction:
      "Restore repository read access and retry publication after the workflow definitions can be verified. Your saved changes are intact.",
  });
}

/** Compare executable definitions before the accepted checkpoint creates any GitHub objects. */
export async function hasRepositoryGitHubPublicationWorkflowChanges(params: {
  snapshot: GitHubRepositoryPublicationSnapshot;
  sourceRepository: string;
  comparisonRepository: string;
  comparisonTree: string;
  readUpstream: () => Promise<
    | { repository: string; ancestorTree: string; sourceAncestorTree: string; targetTree: string }
    | undefined
  >;
  readTree: (repository: string, sha: string) => Promise<unknown>;
}): Promise<boolean> {
  const trees = new Map<string, Promise<TreeEntry[]>>();
  const readTree = (repository: string, sha: string): Promise<TreeEntry[]> => {
    const key = repository + "\0" + sha;
    return getOrCreatePromise(trees, key, async () => {
      const value = await params.readTree(repository, sha);
      if (
        !isRecord(value) ||
        value.sha !== sha ||
        value.truncated !== false ||
        !Array.isArray(value.tree)
      ) {
        throw unavailableWorkflowTree();
      }
      const names = new Set<string>();
      return value.tree.map((entry): TreeEntry => {
        if (
          !isRecord(entry) ||
          typeof entry.path !== "string" ||
          !entry.path ||
          entry.path.includes("/") ||
          names.has(entry.path) ||
          typeof entry.sha !== "string" ||
          !/^[a-f0-9]{40}$/u.test(entry.sha) ||
          typeof entry.mode !== "string" ||
          !(
            (entry.mode === "040000" && entry.type === "tree") ||
            (entry.mode === "160000" && entry.type === "commit") ||
            (["100644", "100755", "120000"].includes(entry.mode) && entry.type === "blob")
          )
        ) {
          throw unavailableWorkflowTree();
        }
        names.add(entry.path);
        return { path: entry.path, mode: entry.mode, sha: entry.sha };
      });
    });
  };
  const workflows = async (repository: string, root: string) => {
    let entries = await readTree(repository, root);
    for (const name of [".github", "workflows"]) {
      const directory = entries.find((entry) => entry.path === name);
      if (directory?.mode !== "040000") {
        return new Map<string, string>();
      }
      entries = await readTree(repository, directory.sha);
    }
    return new Map(
      entries.flatMap((entry) => {
        const file = workflowDirectory + entry.path;
        return entry.mode !== "040000" && isGitHubPublicationWorkflowPath(file)
          ? [[file, entry.mode + ":" + entry.sha] as const]
          : [];
      }),
    );
  };

  const [before, source] = await Promise.all([
    workflows(params.comparisonRepository, params.comparisonTree),
    workflows(params.sourceRepository, params.snapshot.baseTree),
  ]);
  const accepted = new Map(source);
  // A file, symlink or gitlink at either ancestor removes its executable descendants.
  // Clear first so the result does not depend on checkpoint entry ordering.
  if (
    params.snapshot.entries.some(
      (entry) => entry.path === ".github" || entry.path === ".github/workflows",
    )
  ) {
    accepted.clear();
  }
  for (const entry of params.snapshot.entries) {
    if (!isGitHubPublicationWorkflowPath(entry.path)) {
      continue;
    }
    if (entry.sha === null) {
      accepted.delete(entry.path);
    } else {
      accepted.set(entry.path, entry.mode + ":" + entry.sha);
    }
  }
  return await hasUnapprovedGitHubPublicationWorkflowChanges({
    before,
    accepted,
    readUpstream: async () => {
      const upstream = await params.readUpstream();
      if (!upstream) {
        return undefined;
      }
      const [ancestor, sourceAncestor, target] = await Promise.all([
        workflows(upstream.repository, upstream.ancestorTree),
        workflows(upstream.repository, upstream.sourceAncestorTree),
        workflows(upstream.repository, upstream.targetTree),
      ]);
      return { ancestor, sourceAncestor, source, target };
    },
  });
}

export async function hasGitHubPublicationWorkflowChanges(params: {
  cwd: string;
  comparisonCommit: string;
  ancestryCommit: string;
  targetCommit: string;
  accepted: { sourceCommit: string; tree: string };
  run: typeof runPublicationCommand;
}): Promise<boolean> {
  const trees = new Map<string, Promise<Map<string, string>>>();
  const workflows = (tree: string) =>
    getOrCreatePromise(trees, tree, async () => {
      const listing = await params.run(
        ["git", "ls-tree", "-r", "-z", "--full-tree", tree, "--", ".github/workflows"],
        { cwd: params.cwd, maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES },
      );
      if (listing.code !== 0) {
        throw new Error("GitHub publication workspace workflows could not be verified.");
      }
      const entries = new Map<string, string>();
      for (const record of listing.stdout.toString("latin1").split("\0").filter(Boolean)) {
        const tab = record.indexOf("\t");
        const [mode, , sha] = record.slice(0, tab).split(" ");
        if (tab < 0 || !mode || !sha) {
          throw new Error("GitHub publication workspace workflows could not be verified.");
        }
        const file = record.slice(tab + 1);
        if (isGitHubPublicationWorkflowPath(file)) {
          entries.set(file, mode + ":" + sha);
        }
      }
      return entries;
    });
  const [before, accepted] = await Promise.all([
    workflows(params.comparisonCommit),
    workflows(params.accepted.tree),
  ]);
  return await hasUnapprovedGitHubPublicationWorkflowChanges({
    before,
    accepted,
    readUpstream: async () => {
      const readAncestor = async (commit: string) => {
        const result = await params.run(
          ["git", "merge-base", "--all", commit, params.targetCommit],
          { cwd: params.cwd },
        );
        if (result.code !== 0) {
          throw new Error("GitHub publication workflow ancestry could not be verified.");
        }
        const bases = result.stdout.toString("utf8").trim().split(/\s+/u);
        return bases.length === 1 && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(bases[0]!)
          ? bases[0]
          : undefined;
      };
      const ancestorCommit = await readAncestor(params.ancestryCommit);
      if (!ancestorCommit) {
        return undefined;
      }
      const sourceAncestorCommit =
        params.accepted.sourceCommit === params.ancestryCommit
          ? ancestorCommit
          : await readAncestor(params.accepted.sourceCommit);
      if (!sourceAncestorCommit) {
        return undefined;
      }
      const [ancestor, sourceAncestor, source, target] = await Promise.all([
        workflows(ancestorCommit),
        workflows(sourceAncestorCommit),
        workflows(params.accepted.sourceCommit),
        workflows(params.targetCommit),
      ]);
      return { ancestor, sourceAncestor, source, target };
    },
  });
}

const MAX_WORKFLOW_ANCESTRY_COMMITS = 1_000;
const MAX_WORKFLOW_ANCESTRY_BOUNDARIES = 32;

/** Prove one best common ancestor before exempting inherited workflow definitions. */
export async function hasUniqueGitHubPublicationWorkflowAncestor(params: {
  sourceCommit: string;
  ancestor: string;
  readPage: (page: number) => Promise<unknown>;
  readMergeBase: (source: string, target: string) => Promise<string>;
}): Promise<boolean> {
  const { sourceCommit, ancestor } = params;
  const unavailableAncestry = new GitHubPublicationKnownFailure(
    "GitHub returned incomplete workflow ancestry.",
    {
      code: "unavailable",
      nextAction: "Retry after GitHub can return the complete source commit history.",
    },
  );
  const parents = new Map<string, string[]>();
  let total = 0;
  for (let page = 1; page === 1 || parents.size < total; page++) {
    const value = await params.readPage(page);
    if (
      !isRecord(value) ||
      !Array.isArray(value.commits) ||
      typeof value.total_commits !== "number" ||
      !Number.isSafeInteger(value.total_commits) ||
      value.total_commits < 1 ||
      (page > 1 && value.total_commits !== total) ||
      value.commits.length === 0
    ) {
      throw unavailableAncestry;
    }
    total = value.total_commits;
    if (total > MAX_WORKFLOW_ANCESTRY_COMMITS) {
      throw new GitHubPublicationKnownFailure(
        "Workflow inheritance exceeds the source-history limit.",
        {
          code: "github_rejected",
          nextAction: `Ask a maintainer to publish this workspace; guest workflow inheritance checks at most ${MAX_WORKFLOW_ANCESTRY_COMMITS} source commits.`,
        },
      );
    }
    for (const commit of value.commits) {
      const sha = objectSha(commit);
      if (!isRecord(commit) || !Array.isArray(commit.parents) || parents.has(sha)) {
        throw unavailableAncestry;
      }
      parents.set(sha, commit.parents.map(objectSha));
    }
  }
  if (parents.size !== total || !parents.has(sourceCommit)) {
    throw unavailableAncestry;
  }
  // The inverse comparison contains every source-only commit. Its boundary
  // parents are common ancestors; all must be below the reported merge-base
  // to prove it is unique, including when the source itself contains merges.
  const boundary = new Set<string>();
  for (const commitParents of parents.values()) {
    if (!commitParents.length) {
      // Keep merges of unrelated roots maintainer-only rather than infer
      // workflow ownership across a history with no common boundary.
      return false;
    }
    for (const parent of commitParents) {
      if (!parents.has(parent)) {
        boundary.add(parent);
      }
    }
  }
  if (!boundary.size) {
    return false;
  }
  boundary.delete(ancestor);
  if (boundary.size > MAX_WORKFLOW_ANCESTRY_BOUNDARIES) {
    throw new GitHubPublicationKnownFailure(
      "Workflow inheritance exceeds the ancestry-boundary limit.",
      {
        code: "github_rejected",
        nextAction: `Ask a maintainer to publish this workspace; guest workflow inheritance checks at most ${MAX_WORKFLOW_ANCESTRY_BOUNDARIES} additional ancestry boundaries.`,
      },
    );
  }
  for (const parent of boundary) {
    if ((await params.readMergeBase(parent, ancestor)) !== parent) {
      return false;
    }
  }
  return true;
}
