import { normalizeGitHubLogin } from "../utils/github-login.js";
import type { StoredGitHubIdentity } from "./user-profiles.types.js";

export function projectStoredGitHubIdentities(
  rows: readonly {
    profile_id: string;
    subject: string | null;
    canonical_login: string | null;
    primary_github_account_id?: number | null;
  }[],
): Map<string, { accounts: StoredGitHubIdentity[]; primary: StoredGitHubIdentity | undefined }> {
  const profiles = new Map<
    string,
    { accounts: StoredGitHubIdentity[]; primaryId: number | null }
  >();
  for (const row of rows) {
    const accountId = Number(row.subject);
    const login = row.canonical_login ? normalizeGitHubLogin(row.canonical_login) : undefined;
    if (!login || !Number.isSafeInteger(accountId) || accountId <= 0) {
      continue;
    }
    const profile = profiles.get(row.profile_id) ?? {
      accounts: [],
      primaryId: row.primary_github_account_id ?? null,
    };
    profile.accounts.push({ accountId, login });
    profiles.set(row.profile_id, profile);
  }
  return new Map(
    [...profiles].map(([id, { accounts, primaryId }]) => [
      id,
      {
        accounts,
        // Old single-account profiles have an unambiguous primary; never pick one from several.
        primary:
          primaryId === null && accounts.length === 1
            ? accounts[0]
            : accounts.find((account) => account.accountId === primaryId),
      },
    ]),
  );
}
