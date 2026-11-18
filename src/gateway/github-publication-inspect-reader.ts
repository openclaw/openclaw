import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";

type RecordedPublication = {
  url: string;
  publisher: Pick<
    GitHubPublicationExecutionRow,
    | "agent_id"
    | "identity_source"
    | "identity_profile_id"
    | "identity_account_id"
    | "identity_login"
  >;
};

/** Inspection verifies recorded publications are public; other readers require linked identity. */
export function captureOwnGitHubPullRequestReader(
  profileId: string,
  getHost: () => string,
  publication?: RecordedPublication,
) {
  const host = getHost();
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
