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

/** Full-write assistance retains live action authority; ordinary readers require linked identity. */
export function captureOwnGitHubPullRequestReader(
  profileId: string | undefined,
  getHost: () => string,
  publication?: RecordedPublication,
  assertOperatorWrite?: () => void,
) {
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
