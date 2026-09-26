import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type GitHubRepositoryRef = {
  owner: string;
  repo: string;
};

type GitHubRepositoryTarget = {
  fork: boolean;
  push: GitHubRepositoryRef;
  pullRequest: GitHubRepositoryRef & { defaultBranch: string };
};

export function resolveGitHubForkParent(value: unknown): GitHubRepositoryRef | undefined {
  if (!isRecord(value) || value.fork !== true || !isRecord(value.parent)) {
    return undefined;
  }
  const parentOwner = isRecord(value.parent.owner) ? value.parent.owner : undefined;
  const owner = normalizeOptionalString(parentOwner?.login);
  const repo = normalizeOptionalString(value.parent.name);
  return owner && repo ? { owner, repo } : undefined;
}

/** Projects GitHub's repository response into the canonical push/head/base relationship. */
export function resolveGitHubRepositoryTarget(
  value: unknown,
  push: GitHubRepositoryRef,
): GitHubRepositoryTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const defaultBranch = normalizeOptionalString(value.default_branch);
  if (value.fork !== true) {
    return defaultBranch
      ? { fork: false, push, pullRequest: { ...push, defaultBranch } }
      : undefined;
  }
  const parent = resolveGitHubForkParent(value);
  const parentRecord = isRecord(value.parent) ? value.parent : undefined;
  const parentDefaultBranch = normalizeOptionalString(parentRecord?.default_branch);
  return parent && parentDefaultBranch
    ? {
        fork: true,
        push,
        pullRequest: { ...parent, defaultBranch: parentDefaultBranch },
      }
    : undefined;
}
