import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import {
  prepareGitHubPublicationRepositoryIdentity,
  type readGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import { GitHubPublicationWorkspaceChangedError } from "./github-publication-failure.js";
import { requirePublicationCommand } from "./github-publication-git-transport.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { resolveGitHubRepositoryTarget } from "./github-repository-target.js";

/** Resolve the authoritative Git remote and GitHub PR parent with the selected publisher. */
export async function prepareGitHubPublicationTarget(params: {
  worktree: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>["worktree"];
  identity: PreparedGitHubPublicationIdentity;
  assertCurrent: () => void;
}) {
  const { worktree, assertCurrent } = params;
  const githubHost = params.identity.host ?? resolveGitHubHost();
  const repositoryIdentity = await prepareGitHubPublicationRepositoryIdentity(params);
  const remote = parseGitHubRemoteUrl(repositoryIdentity.originUrl, githubHost);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    throw new Error("GitHub publication requires a GitHub remote.");
  }
  const pushRepository = `${remote.owner}/${remote.repo}`;
  const branch = await requirePublicationCommand(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: worktree.path },
  );
  assertCurrent();
  if (branch !== worktree.branch) {
    throw new GitHubPublicationWorkspaceChangedError("GitHub publication branch changed.");
  }
  const raw = await requirePublicationCommand(
    [
      "gh",
      "api",
      "--hostname",
      githubHost,
      `repos/${pushRepository}`,
      "--jq",
      "{fork, default_branch, parent: {name: .parent.name, default_branch: .parent.default_branch, owner: {login: .parent.owner.login}}}",
    ],
    { env: params.identity.env },
  );
  assertCurrent();
  const value: unknown = JSON.parse(raw);
  const target = resolveGitHubRepositoryTarget(value, remote);
  if (!target) {
    throw new Error("GitHub repository response omitted its publication target.");
  }
  const repository = `${target.pullRequest.owner}/${target.pullRequest.repo}`;
  const baseBranch = target.fork
    ? target.pullRequest.defaultBranch
    : parseGitHubPublicationBaseBranch(worktree.baseRef, target.pullRequest.defaultBranch);
  if (!target.fork && branch === baseBranch) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication branch changed to its pull request base.",
    );
  }
  return {
    pushRepository,
    repository,
    branch,
    baseBranch,
    pushOwner: target.push.owner,
    githubHost,
  };
}
