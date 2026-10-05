import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { normalizeVerifiedEmail } from "../shared/verified-email.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import {
  publishUserProfileAuthorityChange,
  publishUserProfileIdentityChange,
} from "./user-profile-events.js";
import type { UserProfileMutationContext } from "./user-profile-mutation.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import type { FactoryGitHubIdentity } from "./user-profiles.types.js";

export const FACTORY_GITHUB_PROVIDER = "github:microsoft.ghe.com";

/** Factory ingress is the only producer; a generic profile alias never establishes this fact. */
export function applyFactoryGitHubIdentity(
  db: DatabaseSync,
  params: {
    profileId: string;
    principal: string;
    metadata?: { login: string; email?: string };
    mutation?: UserProfileMutationContext;
  },
): void {
  const accountId = Number(params.principal.slice(FACTORY_GITHUB_PROVIDER.length + 1));
  const login = params.metadata ? normalizeGitHubLogin(params.metadata.login) : undefined;
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || (params.metadata && !login)) {
    throw new Error("Factory GitHub identity is invalid");
  }
  const subject = String(accountId);
  const email = normalizeVerifiedEmail(params.metadata?.email) ?? null;
  const proof = email ? JSON.stringify({ email, profileId: params.profileId }) : null;
  const kysely = userProfilesDb(db);
  const before = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profile_identities")
      .select(["profile_id", "canonical_login", "verified_email_json"])
      .where("provider", "=", FACTORY_GITHUB_PROVIDER)
      .where("subject", "=", subject),
  );
  if (
    before?.profile_id === params.profileId &&
    before.canonical_login === (login ?? null) &&
    before.verified_email_json === proof
  ) {
    return;
  }
  const changed = [...new Set([params.profileId, ...(before ? [before.profile_id] : [])])];
  params.mutation?.before(db, ...changed);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("user_profile_identities")
      .values({
        provider: FACTORY_GITHUB_PROVIDER,
        subject,
        profile_id: params.profileId,
        canonical_login: login ?? null,
        verified_email_json: proof,
        created_at: Date.now(),
      })
      .onConflict((oc) =>
        oc.columns(["provider", "subject"]).doUpdateSet({
          profile_id: params.profileId,
          canonical_login: login ?? null,
          verified_email_json: proof,
        }),
      ),
  );
  params.mutation?.identity(...changed);
  params.mutation?.authority(...changed);
  params.mutation?.publish(...changed);
  publishUserProfileIdentityChange(db, ...changed);
  publishUserProfileAuthorityChange(db, ...changed);
}

export function selectFactoryGitHubIdentities(
  db: DatabaseSync,
  profileIds: readonly string[],
): Map<string, FactoryGitHubIdentity> {
  if (!profileIds.length) {
    return new Map();
  }
  const rows = executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select(["profile_id", "subject", "canonical_login", "verified_email_json"])
      .where("provider", "=", FACTORY_GITHUB_PROVIDER)
      .where("profile_id", "in", [...profileIds]),
  ).rows;
  const bindings = new Map(
    executeSqliteQuerySync(
      db,
      userProfilesDb(db)
        .selectFrom("user_profile_emails")
        .select(["email", "profile_id"])
        .where("profile_id", "in", [...profileIds]),
    ).rows.map((row) => [row.email, row.profile_id]),
  );
  const identities = new Map<string, FactoryGitHubIdentity>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    const accountId = Number(row.subject);
    const login = row.canonical_login ? normalizeGitHubLogin(row.canonical_login) : undefined;
    // Older generic profile merges may move the row; its verification must not move with it.
    let proof: unknown;
    try {
      if (!row.verified_email_json || row.verified_email_json.length > 1024) {
        continue;
      }
      proof = JSON.parse(row.verified_email_json);
    } catch {
      continue;
    }
    if (!isRecord(proof) || proof.profileId !== row.profile_id) {
      continue;
    }
    const email = normalizeVerifiedEmail(proof.email);
    if (
      !login ||
      !email ||
      !Number.isSafeInteger(accountId) ||
      accountId <= 0 ||
      bindings.get(`${FACTORY_GITHUB_PROVIDER}:${accountId}`) !== row.profile_id ||
      bindings.get(email) !== row.profile_id
    ) {
      continue;
    }
    if (identities.has(row.profile_id)) {
      ambiguous.add(row.profile_id);
    }
    identities.set(row.profile_id, {
      host: "microsoft.ghe.com",
      accountId,
      login,
      verifiedEmail: email,
    });
  }
  for (const profileId of ambiguous) {
    identities.delete(profileId);
  }
  return identities;
}
