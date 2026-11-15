import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { normalizeVerifiedEmail } from "../shared/verified-email.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import type { EnterpriseGitHubIdentity } from "./user-profiles.types.js";

/** Every proof-validated Enterprise identity per profile; callers pick a host or require one. */
export function selectVerifiedEnterpriseGitHubIdentities(
  db: EngineConnection,
  profileIds?: readonly string[],
  host?: string,
): Map<string, EnterpriseGitHubIdentity[]> {
  if (
    profileIds?.length === 0 ||
    !tableHasColumn(db, "user_profile_identities", "verified_email_json")
  ) {
    return new Map();
  }
  let query = userProfilesDb(db)
    .selectFrom("user_profile_identities")
    .select(["provider", "profile_id", "subject", "canonical_login", "verified_email_json"])
    .where("provider", "like", "github:%");
  if (host) {
    query = query.where("provider", "=", `github:${host}`);
  }
  if (profileIds) {
    query = query.where("profile_id", "in", [...profileIds]);
  }
  const rows = executeSqliteQuerySync(db, query).rows;
  if (!rows.length) {
    return new Map();
  }
  const bindings = new Map(
    executeSqliteQuerySync(
      db,
      userProfilesDb(db)
        .selectFrom("user_profile_emails")
        .select(["email", "profile_id", "binding_id"])
        .where(
          "email",
          "in",
          rows.map((row) => `${row.provider}:${row.subject}`),
        ),
    ).rows.map((row) => [row.email, row]),
  );
  const identities = new Map<string, EnterpriseGitHubIdentity[]>();
  for (const row of rows) {
    const principal = parseEnterpriseGitHubPrincipal(`${row.provider}:${row.subject}`);
    const login = row.canonical_login ? normalizeGitHubLogin(row.canonical_login) : undefined;
    let proof: unknown;
    try {
      if (!row.verified_email_json || row.verified_email_json.length > 1024) {
        continue;
      }
      proof = JSON.parse(row.verified_email_json);
    } catch {
      continue;
    }
    if (
      !principal ||
      !isRecord(proof) ||
      proof.version !== 1 ||
      proof.profileId !== row.profile_id ||
      !login
    ) {
      continue;
    }
    const { accountId } = principal;
    const binding = bindings.get(`${row.provider}:${accountId}`);
    if (binding?.profile_id !== row.profile_id || binding.binding_id !== proof.bindingId) {
      continue;
    }
    const email = normalizeVerifiedEmail(proof.email);
    const verified = identities.get(row.profile_id) ?? [];
    verified.push({
      host: principal.host,
      accountId,
      login,
      ...(email ? { verifiedEmail: email } : {}),
    });
    identities.set(row.profile_id, verified);
  }
  return identities;
}

/** Display and credit need one identity; a profile with several verified ones shows none. */
export function selectEnterpriseGitHubIdentities(
  db: EngineConnection,
  profileIds?: readonly string[],
  host?: string,
): Map<string, EnterpriseGitHubIdentity> {
  return unambiguousEnterpriseGitHubIdentities(
    selectVerifiedEnterpriseGitHubIdentities(db, profileIds, host),
  );
}

/** Host/account pairs of verified identities, in a stable order, for catalog facts. */
export function enterpriseGitHubAccountPairs(identities: readonly EnterpriseGitHubIdentity[]) {
  return identities
    .map(({ host, accountId }) => ({ host, accountId }))
    .toSorted(
      (left, right) => left.host.localeCompare(right.host) || left.accountId - right.accountId,
    );
}

export function unambiguousEnterpriseGitHubIdentities(
  verified: ReadonlyMap<string, readonly EnterpriseGitHubIdentity[]>,
): Map<string, EnterpriseGitHubIdentity> {
  const identities = new Map<string, EnterpriseGitHubIdentity>();
  for (const [profileId, candidates] of verified) {
    const [identity] = candidates;
    if (identity && candidates.length === 1) {
      identities.set(profileId, identity);
    }
  }
  return identities;
}

/** Saved consent survives explicit merge chains even when credit needs fresh sign-in. */
export function selectEnterpriseGitHubProfileIdsForMerge(
  db: EngineConnection,
  profileIds: readonly string[],
): Set<string> {
  if (profileIds.length === 0) {
    return new Set();
  }
  return new Set(
    executeSqliteQuerySync(
      db,
      userProfilesDb(db)
        .selectFrom("user_profile_identities")
        .select("profile_id")
        .distinct()
        .where("provider", "like", "github:%")
        .where("profile_id", "in", [...profileIds]),
    ).rows.map((row) => row.profile_id),
  );
}
