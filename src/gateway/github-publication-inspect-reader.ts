import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";

/** Linked identity only. The caller retains current session, role and connection authority. */
export function captureOwnGitHubPullRequestReader(profileId: string, getHost: () => string) {
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
  if (!admittedIds.length) {
    throw new Error(
      "Link a verified GitHub account on the configured host before inspecting your PR.",
    );
  }
  return {
    host,
    accountIds: admittedIds,
    identity: JSON.stringify([profileId, host, admittedIds.toSorted((a, b) => a - b)]),
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
