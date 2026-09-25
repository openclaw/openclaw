import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  GitHubPublicationKnownFailure,
  GitHubPublicationWorkflowChangesError,
} from "./github-publication-failure.js";
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

export function isGitHubPublicationWorkflowPath(file: string): boolean {
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
  readTree: (repository: string, sha: string) => Promise<unknown>;
}): Promise<boolean> {
  const trees = new Map<string, Promise<TreeEntry[]>>();
  const readTree = (repository: string, sha: string): Promise<TreeEntry[]> => {
    const key = repository + "\0" + sha;
    let pending = trees.get(key);
    if (!pending) {
      pending = (async () => {
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
      })();
      trees.set(key, pending);
    }
    return pending;
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

  const [before, accepted] = await Promise.all([
    workflows(params.comparisonRepository, params.comparisonTree),
    workflows(params.sourceRepository, params.snapshot.baseTree),
  ]);
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
  return (
    before.size !== accepted.size ||
    [...before].some(([file, object]) => accepted.get(file) !== object)
  );
}
