import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { readRepositoryPublicationTargetFacts } from "./github-publication-availability.js";
import { RepositoryPublicationWorkspaceChangedError } from "./github-publication-errors.js";
import { assertExpectedPublisher } from "./github-publication-policy.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import type { PublicationSessionIdentity } from "./github-publication-session.types.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import type {
  RepositoryPublicationTarget,
  RepositoryPublicationPublisher,
  RepositoryPublicationProvider,
} from "./repository-publication-contract.js";

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
