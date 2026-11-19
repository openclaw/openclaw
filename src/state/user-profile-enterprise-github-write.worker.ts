import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { normalizeVerifiedEmail } from "../shared/verified-email.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import { ensureProfileForEmailInDatabase } from "./user-profile-email.kernel.js";
import {
  publishUserProfileAuthorityChange,
  publishUserProfileIdentityChange,
} from "./user-profile-events.js";
import { publishUserProfilesChange } from "./user-profile-list.js";
import {
  runUserProfileWriteTransaction,
  type UserProfileMutationContext,
  type UserProfileMutationOptions,
} from "./user-profile-mutation.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import { ensureUserProfilesSchema, UserProfileOwnerError } from "./user-profiles-schema.js";
import { normalizeInitialDisplayName } from "./user-profiles.js";

/** Only current authenticated Enterprise GitHub metadata can establish this host-scoped credit binding. */
function applyEnterpriseGitHubIdentity(
  db: EngineConnection,
  params: {
    profileId: string;
    principal: string;
    metadata: { login: string; email?: string };
    mutation?: UserProfileMutationContext;
  },
): number | undefined {
  if (params.profileId === GATEWAY_OWNER_PROFILE_ID) {
    throw new UserProfileOwnerError("merge");
  }
  const principal = parseEnterpriseGitHubPrincipal(params.principal);
  const accountId = principal?.accountId ?? Number.NaN;
  const provider = principal ? `github:${principal.host}` : "";
  const login = normalizeGitHubLogin(params.metadata.login);
  const binding = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_emails")
      .select(["profile_id", "binding_id"])
      .where("email", "=", params.principal),
  );
  if (
    !Number.isSafeInteger(accountId) ||
    !login ||
    binding?.profile_id !== params.profileId ||
    !binding.binding_id
  ) {
    throw new Error("Enterprise GitHub identity is invalid");
  }
  const email = normalizeVerifiedEmail(params.metadata.email);
  if (params.metadata.email !== undefined && !email) {
    throw new Error("Enterprise GitHub verified email is invalid");
  }
  // Historical payloads and moved aliases cannot confer credit. Reauthentication writes this binding.
  const proof = JSON.stringify({
    version: 1,
    profileId: params.profileId,
    bindingId: binding.binding_id,
    ...(email ? { email } : {}),
  });
  const kysely = userProfilesDb(db);
  const before = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profile_identities")
      .select(["profile_id", "canonical_login", "verified_email_json"])
      .where("provider", "=", provider)
      .where("subject", "=", String(accountId)),
  );
  if (
    before?.profile_id === params.profileId &&
    before.canonical_login === login &&
    before.verified_email_json === proof
  ) {
    return undefined;
  }
  const changed = [...new Set([params.profileId, ...(before ? [before.profile_id] : [])])];
  params.mutation?.before(db, ...changed);
  const values = {
    profile_id: params.profileId,
    canonical_login: login,
    verified_email_json: proof,
  };
  const now = Date.now();
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("user_profile_identities")
      .values({
        provider,
        subject: String(accountId),
        ...values,
        created_at: now,
      })
      .onConflict((oc) => oc.columns(["provider", "subject"]).doUpdateSet(values)),
  );
  executeSqliteQuerySync(
    db,
    kysely.updateTable("user_profiles").set({ updated_at: now }).where("id", "=", params.profileId),
  );
  params.mutation?.identity(...changed);
  params.mutation?.authority(...changed);
  params.mutation?.publish(...changed);
  publishUserProfileIdentityChange(db, ...changed);
  publishUserProfileAuthorityChange(db, ...changed);
  publishUserProfilesChange(db, ...changed);
  return now;
}

/** Creation, display adoption, and verified credit settle in the profile writer's transaction. */
export function ensureEnterpriseGitHubProfile(
  principal: string,
  name: string,
  metadata: { login: string; email?: string },
  options: UserProfileMutationOptions,
) {
  ensureUserProfilesSchema(options);
  const displayName = normalizeInitialDisplayName(name);
  return runUserProfileWriteTransaction(
    ({ db }) => {
      const now = Date.now();
      const profile = ensureProfileForEmailInDatabase(
        db,
        principal,
        displayName,
        now,
        options.mutation,
      );
      const adoptsName = Boolean(displayName && profile.displayName === principal);
      if (adoptsName) {
        options.mutation?.before(db, profile.id);
        executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .updateTable("user_profiles")
            .set({ display_name: displayName, updated_at: now })
            .where("id", "=", profile.id),
        );
        options.mutation?.publish(profile.id);
        publishUserProfilesChange(db, profile.id);
      }
      const identityUpdatedAt = applyEnterpriseGitHubIdentity(db, {
        profileId: profile.id,
        principal,
        metadata,
        mutation: options.mutation,
      });
      return {
        ...profile,
        displayName: adoptsName ? displayName : profile.displayName,
        updatedAt: identityUpdatedAt ?? (adoptsName ? now : profile.updatedAt),
      };
    },
    options,
    { operationLabel: "user-profiles.enterprise-github-identity" },
  );
}
