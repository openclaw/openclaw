import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import { GitHubPublicationWorkspaceChangedError } from "./github-publication-failure.js";
import {
  githubPublicationApiArgs,
  requirePublicationCommand,
} from "./github-publication-git-transport.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

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

export async function prepareRepositoryGitHubPublicationTarget(
  workspace: SessionRepositoryWorkspaceRecord,
  identity: PreparedGitHubPublicationIdentity,
  assertCurrent: () => void,
) {
  const githubHost = identity.host ?? resolveGitHubHost();
  const remote = parseGitHubRemoteUrl(workspace.url, githubHost);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    throw new Error("GitHub publication requires a GitHub remote.");
  }
  const pushRepository = remote.owner + "/" + remote.repo;
  const value: unknown = JSON.parse(
    await requirePublicationCommand(
      githubPublicationApiArgs("repos/" + pushRepository, "GET", githubHost),
      { env: identity.env, beforeRun: assertCurrent },
    ),
  );
  assertCurrent();
  const target = resolveGitHubRepositoryTarget(value, remote);
  if (!target) {
    throw new Error("GitHub repository response omitted its publication target.");
  }
  const baseBranch = target.pullRequest.defaultBranch;
  if (workspace.branch === baseBranch) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication branch is its pull request base.",
    );
  }
  return {
    pushRepository,
    repository: target.pullRequest.owner + "/" + target.pullRequest.repo,
    baseBranch,
  };
}
