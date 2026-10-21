import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionGitHubPullRequestInspectResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";

type PullRequest = Pick<
  SessionGitHubPullRequestInspectResult,
  "host" | "number" | "author" | "state" | "base" | "head"
>;

/** Recheck eligibility and return the observed PR for the caller's remaining effect preconditions. */
export async function assertExistingPullRequestWriteAccess(params: {
  pullRequest: PullRequest;
  identity: PreparedGitHubPublicationIdentity;
  assertCurrent: () => void;
}): Promise<unknown> {
  const { pullRequest: pr, identity, assertCurrent } = params;
  assertCurrent();
  if ((identity.host ?? "github.com") !== pr.host) {
    throw new Error("The GitHub publisher host changed; inspect the PR again before preparation.");
  }
  if (pr.state !== "open" && pr.state !== "draft") {
    throw new Error("This PR is closed or merged; it cannot be continued as an open PR.");
  }
  const head = pr.head;
  if (!head) {
    throw new Error(
      "The original head repository is unavailable. Restore it before continuing this PR.",
    );
  }
  const unavailable = () =>
    new Error(
      "The original PR's write eligibility could not be verified. Check the head branch and the publisher's access, then retry preparation.",
    );
  const read = async (endpoint: string): Promise<unknown> => {
    assertCurrent();
    const response = await runPublicationCommand(
      githubPublicationApiArgs(endpoint, "GET", pr.host),
      { env: identity.env, beforeRun: assertCurrent },
    ).catch(() => {
      assertCurrent();
      throw unavailable();
    });
    assertCurrent();
    if (response.code !== 0) {
      throw unavailable();
    }
    try {
      return JSON.parse(response.stdout.toString("utf8"));
    } catch {
      throw unavailable();
    }
  };
  const repository = async (ref: NonNullable<PullRequest["head"]>) => {
    const value = await read(`repos/${ref.repository}`);
    if (
      !isRecord(value) ||
      value.id !== ref.repositoryId ||
      value.full_name !== ref.repository ||
      typeof value.archived !== "boolean" ||
      !isRecord(value.owner) ||
      typeof value.owner.type !== "string"
    ) {
      throw unavailable();
    }
    const permissions = isRecord(value.permissions) ? value.permissions : undefined;
    return {
      archived: value.archived,
      ownerType: value.owner.type,
      push: typeof permissions?.push === "boolean" ? permissions.push : undefined,
    };
  };
  const baseRepository = await repository(pr.base);
  const headRepository =
    head.repositoryId === pr.base.repositoryId ? baseRepository : await repository(head);
  if (baseRepository.archived || headRepository.archived) {
    throw new Error(
      "The base or head repository is archived. It must be writable before continuing.",
    );
  }
  const current = await read(`repos/${pr.base.repository}/pulls/${pr.number}`);
  if (
    !isRecord(current) ||
    current.number !== pr.number ||
    !isRecord(current.user) ||
    current.user.id !== pr.author.accountId ||
    current.state !== "open" ||
    current.merged !== false ||
    typeof current.maintainer_can_modify !== "boolean" ||
    !isRecord(current.base) ||
    !isRecord(current.base.repo) ||
    current.base.repo.id !== pr.base.repositoryId ||
    current.base.ref !== pr.base.branch ||
    !isRecord(current.head) ||
    !isRecord(current.head.repo) ||
    current.head.repo.id !== head.repositoryId ||
    current.head.ref !== head.branch ||
    current.head.sha !== head.commit
  ) {
    throw new Error("The original PR or head changed. Inspect it again before preparing work.");
  }
  const branch = await read(`repos/${head.repository}/branches/${encodeURIComponent(head.branch)}`);
  if (
    !isRecord(branch) ||
    branch.name !== head.branch ||
    !isRecord(branch.commit) ||
    branch.commit.sha !== head.commit ||
    typeof branch.protected !== "boolean"
  ) {
    throw new Error(
      "The original head branch changed or is unavailable. Inspect it again before preparing work.",
    );
  }
  const permitted =
    headRepository.push === true ||
    (current.maintainer_can_modify &&
      baseRepository.push === true &&
      headRepository.ownerType === "User" &&
      head.repositoryId !== pr.base.repositoryId);
  if (!permitted) {
    if (headRepository.push === undefined || baseRepository.push === undefined) {
      throw new Error(
        "GitHub did not expose enough publisher permission information to prepare this PR.",
      );
    }
    throw new Error(
      "The publisher has no observed write permission to the original head. Grant repository access or allow maintainer edits on an eligible fork.",
    );
  }
  if (branch.protected) {
    throw new Error(
      "The head branch is protected. Repository permission alone does not establish that the publisher can append commits.",
    );
  }
  assertCurrent();
  return current;
}
