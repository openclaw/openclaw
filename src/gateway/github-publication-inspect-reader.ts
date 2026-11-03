import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { captureGitHubPublicationActionAuthority } from "./github-publication-requester.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";
import type { PublicationSessionIdentity } from "./github-publication-session.types.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import type { RepositoryPublicationOwnPullRequestReader } from "./repository-session-read.types.js";

/** Full-write assistance retains live action authority; ordinary readers require linked identity. */
export function captureOwnGitHubPullRequestReader(
  profileId: string | undefined,
  getHost: () => string,
  publication?: NonNullable<RepositoryPublicationOwnPullRequestReader["publication"]>,
  assertOperatorWrite?: () => void,
): RepositoryPublicationOwnPullRequestReader {
  const host = getHost();
  if (assertOperatorWrite) {
    const assertCurrent = () => {
      assertOperatorWrite();
      if (getHost() !== host) {
        throw new Error("The GitHub host changed; retry inspection.");
      }
    };
    assertCurrent();
    const accountIds: number[] = [];
    return {
      host,
      accountIds,
      publication,
      operatorWrite: true,
      identity: JSON.stringify(["operator.write", profileId, host]),
      assertCurrent,
    };
  }
  if (!profileId) {
    throw new Error("Inspecting your PR requires your verified linked GitHub account.");
  }
  const profile = captureResidentUserProfileAccess(profileId);
  const accountIds = () => {
    const facts = profile.readCurrentFacts();
    // Enterprise identity comes from the catalog's proof-validated binding; a principal-shaped alias alone never qualifies.
    return host === "github.com"
      ? [...(facts.githubAccountIds ?? [])]
      : (facts.enterpriseGitHubAccounts ?? []).flatMap((account) =>
          account.host === host ? [account.accountId] : [],
        );
  };
  const admittedIds = accountIds();
  if (!admittedIds.length && !publication) {
    throw new Error(
      "Link a verified GitHub account on the configured host before inspecting your PR.",
    );
  }
  return {
    host,
    accountIds: admittedIds,
    publication,
    operatorWrite: false,
    identity: JSON.stringify([
      profileId,
      host,
      admittedIds.toSorted((a, b) => a - b),
      ...(publication ? [publication] : []),
    ]),
    assertCurrent: () => {
      const currentIds = accountIds();
      if (getHost() !== host || !admittedIds.every((id) => currentIds.includes(id))) {
        throw new Error(
          "Your linked GitHub identity changed; retry inspection with your current account.",
        );
      }
    },
  };
}

/** Native requester admission selects this one linked-account reader before vendor code runs. */
export async function prepareOwnGitHubPullRequestReader(
  requester: GitHubPublicationRequesterPolicyV2,
  session?: PublicationSessionIdentity,
) {
  const authority = captureGitHubPublicationActionAuthority(requester);
  const actor = requester.snapshot.actor;
  if (!authority.operatorWrite && actor.kind !== "operator") {
    throw new Error("Inspecting your PR requires your verified linked GitHub account.");
  }
  const published = session
    ? await readSharedGitHubPublication(session, {
        status: "published",
        authorEligibilityOnly: true,
      })
    : undefined;
  authority.assertCurrent();
  const reader = captureOwnGitHubPullRequestReader(
    actor.kind === "operator" ? actor.profileId : undefined,
    () => resolveConfiguredGitHubHost(readRuntimeConfig()),
    published?.pull_request_url && published.identity_account_id !== null
      ? {
          url: published.pull_request_url,
          ...(published.head_commit ? { headCommit: published.head_commit } : {}),
          publisher: {
            agentId: published.agent_id,
            source: published.identity_source,
            profileId: published.identity_profile_id,
            accountId: published.identity_account_id,
            login: published.identity_login,
          },
        }
      : undefined,
    authority.operatorWrite ? authority.assertOperatorWrite : undefined,
  );
  return {
    ...reader,
    assertCurrent() {
      authority.assertCurrent();
      reader.assertCurrent();
    },
  };
}
