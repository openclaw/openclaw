import type { SessionGitHubPullRequestInspectResult } from "../../packages/gateway-protocol/src/index.js";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { readRepositoryPublicationTargetFacts } from "./github-publication-availability.js";
import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import {
  RepositoryPublicationRequesterUnavailableError,
  RepositoryPublicationWorkspaceChangedError,
} from "./github-publication-errors.js";
import { GitHubPublicationBranchChangedError } from "./github-publication-failure.js";
import { assertExpectedPublisher } from "./github-publication-policy.js";
import { inspectOwnGitHubPullRequest } from "./github-publication-pr-inspect.js";
import { assertExistingPullRequestWriteAccess } from "./github-publication-pr-preflight.js";
import { readGitHubPublisher } from "./github-publication-publisher.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { requireGitHubPublicationCommand } from "./github-publication-remote.js";
import type { PublicationSessionIdentity } from "./github-publication-session.types.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { resolveGitHubRepositoryTarget } from "./github-repository-target.js";
import type {
  RepositoryPublicationProvider,
  RepositoryPublicationTarget,
  RepositoryPublicationPublisher,
} from "./repository-publication-contract.js";

/** Resolve the authoritative Git remote and GitHub PR parent with the selected publisher. */
export async function prepareGitHubPublicationTarget(params: {
  source: {
    originUrl: string;
    branch: string;
    baseRef: string;
    pullRequest?: SessionGitHubPullRequestBinding;
  };
  identity: PreparedGitHubPublicationIdentity;
  assertCurrent: () => void;
}) {
  const { source, assertCurrent } = params;
  const githubHost = params.identity.host ?? resolveGitHubHost();
  if (source.pullRequest) {
    const pr = source.pullRequest;
    if (
      pr.host !== githubHost ||
      !pr.preparedHeadCommit ||
      pr.preparedHeadCommit !== pr.head.commit
    ) {
      throw new RepositoryPublicationWorkspaceChangedError(
        "The original PR preparation is incomplete or its publisher host changed.",
      );
    }
    return {
      pushRepository: pr.head.repository,
      repository: pr.base.repository,
      branch: pr.head.branch,
      baseBranch: pr.base.branch,
      pushOwner: pr.head.repository.split("/")[0]!,
      githubHost,
    };
  }
  const remote = parseGitHubRemoteUrl(source.originUrl, githubHost);
  if (
    !remote ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(remote.repo)
  ) {
    throw new Error("GitHub publication requires a GitHub remote.");
  }
  const pushRepository = `${remote.owner}/${remote.repo}`;
  const branch = source.branch;
  const raw = await requireGitHubPublicationCommand(
    [
      "gh",
      "api",
      "--hostname",
      githubHost,
      `repos/${pushRepository}`,
      "--jq",
      "{fork, default_branch, parent: {name: .parent.name, default_branch: .parent.default_branch, owner: {login: .parent.owner.login}}}",
    ],
    { env: params.identity.env, beforeRun: assertCurrent },
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
    : parseGitHubPublicationBaseBranch(source.baseRef, target.pullRequest.defaultBranch);
  if (!target.fork && branch === baseBranch) {
    throw new RepositoryPublicationWorkspaceChangedError(
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

/** A refreshed observation must still name the bound PR and its original repositories/refs. */
function assertBoundGitHubPullRequest(
  binding: SessionGitHubPullRequestBinding,
  current: SessionGitHubPullRequestInspectResult,
): void {
  if (
    current.url !== binding.url ||
    current.host !== binding.host ||
    current.number !== binding.number ||
    !current.head ||
    current.base.repository !== binding.base.repository ||
    current.base.repositoryId !== binding.base.repositoryId ||
    current.base.branch !== binding.base.branch ||
    current.head.repository !== binding.head.repository ||
    current.head.repositoryId !== binding.head.repositoryId ||
    current.head.branch !== binding.head.branch
  ) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "The original PR target changed; saved work was preserved.",
    );
  }
}

/** Revalidate the exact existing PR; local receipt ancestry remains host-owned. */
export async function prepareBoundGitHubPublication(
  params: Parameters<RepositoryPublicationProvider["prepareBoundPublication"]>[0],
) {
  const binding = params.pullRequest;
  let assertInspected: (() => void) | undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    try {
      assertInspected?.();
    } catch {
      throw new RepositoryPublicationRequesterUnavailableError();
    }
  };
  const refresh = async () => {
    const inspected = await inspectOwnGitHubPullRequest({
      pullRequestUrl: binding.url,
      agentId: params.agentId,
      reader: params.reader,
      assertCurrent: params.assertCurrent,
    }).catch(() => {
      throw new RepositoryPublicationRequesterUnavailableError();
    });
    assertBoundGitHubPullRequest(binding, inspected.result);
    const observedHead = inspected.result.head!.commit;
    // A retried request may already have pushed its own journaled commit. The executor
    // verifies that commit's exact tree, parent and request marker before any new effect.
    const observedPublication =
      params.journaledHead !== params.sourceHead && observedHead === params.journaledHead;
    if (observedHead !== params.expectedHead && !observedPublication) {
      throw new GitHubPublicationBranchChangedError({ originalPullRequest: true });
    }
    assertInspected = inspected.assertCurrent;
    if (!observedPublication) {
      await assertExistingPullRequestWriteAccess({
        pullRequest: inspected.result,
        identity: await (async () => {
          await params.publisher.refresh();
          return readGitHubPublisher(params.publisher);
        })(),
        assertCurrent,
        requirePublicRepositories: inspected.requirePublicRepositories,
      });
    }
    assertCurrent();
    return observedPublication;
  };
  const observedPublication = await refresh();
  return { assertCurrent, refresh, observedPublication };
}

/** A host receipt selects the original PR; only immutable target facts cross into the provider. */
export async function preparePublishedPullRequestTarget(
  params: {
    session?: PublicationSessionIdentity;
    provider: RepositoryPublicationProvider;
    publisher: RepositoryPublicationPublisher;
    reconcile?: boolean;
    assertCurrent: () => void;
  },
  target: RepositoryPublicationTarget,
): Promise<RepositoryPublicationTarget> {
  if (!params.session) {
    return target;
  }
  const receipt = await readSharedGitHubPublication(params.session, { status: "published" });
  params.assertCurrent();
  if (!receipt) {
    return target;
  }
  if (
    !("worktree_id" in receipt) ||
    receipt.repository?.toLowerCase() !== target.repository.toLowerCase() ||
    receipt.branch !== target.branch
  ) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "The original publication's repository or head branch changed; saved work was preserved.",
    );
  }
  const publisher = projectGitHubPublicationResult(receipt).publisher;
  const url = URL.parse(receipt.pull_request_url ?? "");
  const number = Number(url?.pathname.split("/").at(-1));
  const host = new URL(target.baseRemoteUrl).host;
  if (
    !url ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    url.href.toLowerCase() !== `https://${host}/${receipt.repository}/pull/${number}`.toLowerCase()
  ) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "The original publication's PR is invalid.",
    );
  }
  const prepared = await params.provider.preparePublishedTarget({
    target,
    publisher: params.publisher,
    publishedPullRequest: { url: url.href, number, pushRepository: target.pushRepository },
    publisherAccountId: publisher?.accountId,
    reconcile: params.reconcile,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  if (prepared.publishedPullRequest) {
    assertExpectedPublisher(publisher, {
      source: params.publisher.provenance.source,
      ...params.publisher.provenance.account,
    });
  }
  return prepared;
}

/** Host source facts and receipts select one current workspace publication target. */
export async function prepareRepositoryPublicationWorkspaceTarget(params: {
  worktree: ManagedWorktreeRecord;
  provider: RepositoryPublicationProvider;
  publisher: RepositoryPublicationPublisher;
  pullRequest?: SessionGitHubPullRequestBinding;
  session?: PublicationSessionIdentity;
  assertCurrent: () => void;
}): Promise<RepositoryPublicationTarget> {
  const initial = await params.provider.prepareTarget({
    ...(await readRepositoryPublicationTargetFacts(params)),
    ...(params.pullRequest ? { pullRequest: params.pullRequest } : {}),
    publisher: params.publisher,
    assertCurrent: params.assertCurrent,
  });
  // An explicitly prepared PR retains its requester/author admission ahead of receipt fallback.
  if (params.pullRequest) {
    return initial;
  }
  return await preparePublishedPullRequestTarget(params, initial);
}

/** Preserve a dispatched attempt's recorded destination until its effects are reconciled. */
export async function prepareGitHubPublicationExecutionTarget(params: {
  worktree: ManagedWorktreeRecord;
  provider: RepositoryPublicationProvider;
  publisher: RepositoryPublicationPublisher;
  pullRequest?: SessionGitHubPullRequestBinding;
  row: GitHubPublicationExecutionRow;
  lifecycleRevision: string | null;
  expectedTarget?: Pick<
    RepositoryPublicationTarget,
    "pushRepository" | "repository" | "baseBranch"
  >;
  assertCurrent: () => void;
}): Promise<{ status: "reconcile" } | { status: "ready"; target: RepositoryPublicationTarget }> {
  const { row } = params;
  const target = await prepareRepositoryPublicationWorkspaceTarget({
    ...params,
    session:
      row.identity_source === "personal"
        ? undefined
        : {
            agentId: row.agent_id,
            sessionKey: row.session_key,
            sessionId: row.session_id,
            lifecycleRevision: params.lifecycleRevision,
          },
  });
  const expected = params.expectedTarget;
  if (
    expected &&
    (expected.pushRepository !== target.pushRepository ||
      expected.repository !== target.repository ||
      expected.baseBranch !== target.baseBranch)
  ) {
    throw new RepositoryPublicationWorkspaceChangedError(
      "GitHub publication accepted repository target changed.",
    );
  }
  if (row.head_commit && row.base_branch && row.base_branch !== target.baseBranch) {
    return { status: "reconcile" };
  }
  return { status: "ready", target };
}
