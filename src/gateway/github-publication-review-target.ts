import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import {
  githubPublicationBaseLookupArgs,
  parseGitHubPublicationBaseRef,
} from "./github-publication-base.js";
import { GitHubPublicationWorkspaceChangedError } from "./github-publication-failure.js";
import {
  createGitHubPublicationCommandRunner,
  githubPublicationApiArgs,
} from "./github-publication-git-transport.js";
import type { GitHubPublicationReviewCandidate } from "./github-publication-review-contract.js";

type ReviewTarget = GitHubPublicationReviewCandidate["target"];

/** Names select routes; immutable GitHub repository IDs bind the reviewed destination. */
export async function readGitHubPublicationReviewTarget(input: {
  target: Pick<ReviewTarget, "pushRepository" | "repository" | "branch" | "baseBranch">;
  identity: PreparedGitHubPublicationIdentity;
  assertCurrent: () => void;
}): Promise<ReviewTarget> {
  const { target, identity, assertCurrent } = input;
  const { require: command } = createGitHubPublicationCommandRunner(assertCurrent);
  const repositoryId = async (repository: string) => {
    const raw = await command(
      [...githubPublicationApiArgs(`repos/${repository}`), "--jq", "{id}"],
      {
        env: identity.env,
      },
    );
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1
    ) {
      throw new Error("The publication repository identity could not be verified.");
    }
    return value.id;
  };
  const pushId = await repositoryId(target.pushRepository);
  const [baseRaw, headRaw, pullRequestRepositoryId] = await Promise.all([
    command(githubPublicationBaseLookupArgs(target.repository, target.baseBranch), {
      env: identity.env,
    }),
    command(
      githubPublicationApiArgs(
        `repos/${target.pushRepository}/git/matching-refs/heads/${encodeURIComponent(target.branch)}`,
      ),
      { env: identity.env },
    ),
    target.repository === target.pushRepository
      ? Promise.resolve(pushId)
      : repositoryId(target.repository),
  ]);
  assertCurrent();
  const refs: unknown = JSON.parse(headRaw);
  if (!Array.isArray(refs)) {
    throw new Error("The publication branch could not be verified.");
  }
  const exact = refs.filter((ref) => isRecord(ref) && ref.ref === `refs/heads/${target.branch}`);
  if (exact.length > 1) {
    throw new Error("The publication branch identity is ambiguous.");
  }
  const ref: unknown = exact[0];
  const sha = isRecord(ref) && isRecord(ref.object) ? ref.object.sha : null;
  if (sha !== null && (typeof sha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))) {
    throw new Error("The publication branch could not be verified.");
  }
  return {
    pushRepository: target.pushRepository,
    repository: target.repository,
    branch: target.branch,
    baseBranch: target.baseBranch,
    pushRepositoryId: pushId,
    repositoryId: pullRequestRepositoryId,
    baseCommit: parseGitHubPublicationBaseRef(baseRaw, target.baseBranch),
    remoteHeadCommit: sha,
  };
}

export function assertGitHubPublicationReviewedTarget(
  reviewed: ReviewTarget,
  current: ReviewTarget,
  ownPublishedHead?: string | null,
): void {
  if (
    reviewed.pushRepository !== current.pushRepository ||
    reviewed.repository !== current.repository ||
    reviewed.pushRepositoryId !== current.pushRepositoryId ||
    reviewed.repositoryId !== current.repositoryId ||
    reviewed.branch !== current.branch ||
    reviewed.baseBranch !== current.baseBranch ||
    reviewed.baseCommit !== current.baseCommit ||
    (reviewed.remoteHeadCommit !== current.remoteHeadCommit &&
      (!ownPublishedHead || current.remoteHeadCommit !== ownPublishedHead))
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "The reviewed publication target or branch changed. Prepare and review a new candidate.",
    );
  }
}
