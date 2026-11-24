import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { parseEnterpriseGitHubPrincipal } from "../shared/enterprise-github-principal.js";
import { normalizeVerifiedEmail } from "../shared/verified-email.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { RegisteredStateReadCommand } from "./openclaw-state-read-operation-registry.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import {
  listUserChannelIdentitiesInDatabase,
  resolveUserChannelIdentityInDatabase,
} from "./user-channel-identities.js";
import { readUserChannelIdentityResult } from "./user-channel-identities.worker.js";
import { readUserProfileCatalogIdentity } from "./user-profile-catalog-identity.read.js";
import { delegatedProfileProvider } from "./user-profile-delegation.js";
import { selectVerifiedEnterpriseGitHubIdentities } from "./user-profile-enterprise-github-identity.js";
import {
  githubAuthenticationSubject,
  readUserProfileGitHubCommand,
  selectUserProfileGitHubIdentities,
} from "./user-profile-github-identity.js";
import {
  readUserProfileSnapshotCommand,
  selectUserProfileIdentityInDatabase,
} from "./user-profile-identity.read.js";
import { openClawIdProfileProvider } from "./user-profile-openclaw-id.types.js";
import {
  inspectProfileAvatarInDatabase,
  readUserProfileAvatarCommand,
  selectResolvedUserProfileMetadataById,
  userProfilesDb,
} from "./user-profiles-internal.js";
import type { ExistingUserProfileAuthentication } from "./user-profiles.types.js";

/** Resolve only an exact persisted authentication key; display names and email lookalikes are irrelevant. */
function selectExistingUserProfileAuthentication(
  db: EngineConnection,
  selector: Extract<ExistingUserProfileAuthentication, { kind: "provider" | "enterprise-github" }>,
) {
  if (!tableExists(db, "user_profiles") || !tableExists(db, "user_profile_identities")) {
    return undefined;
  }
  const enterprise =
    selector.kind === "enterprise-github"
      ? parseEnterpriseGitHubPrincipal(selector.principal)
      : undefined;
  if (selector.kind === "enterprise-github" && !enterprise) {
    return undefined;
  }
  const provider =
    selector.kind === "provider"
      ? selector.provider.trim().toLowerCase()
      : `github:${enterprise!.host}`;
  const subject =
    selector.kind === "provider"
      ? provider === "github"
        ? githubAuthenticationSubject(selector.subject)
        : provider === openClawIdProfileProvider
          ? selector.subject // OCID account keys are opaque and case-sensitive, as in their writer.
          : selector.subject.trim().toLowerCase()
      : String(enterprise!.accountId);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profile_identities")
      .select("profile_id")
      .where("provider", "=", provider)
      .where("subject", "=", subject),
  );
  if (!row) {
    return undefined;
  }
  if (selector.kind === "enterprise-github" && enterprise) {
    const expectedEmail = normalizeVerifiedEmail(selector.email);
    const identity = selectVerifiedEnterpriseGitHubIdentities(
      db,
      [row.profile_id],
      enterprise.host,
      enterprise.accountId,
    ).get(row.profile_id)?.[0];
    if (
      !identity ||
      (selector.login !== undefined &&
        identity.login.toLowerCase() !== normalizeGitHubLogin(selector.login)?.toLowerCase()) ||
      (selector.email !== undefined && (!expectedEmail || identity.verifiedEmail !== expectedEmail))
    ) {
      return undefined;
    }
  }
  const profile = selectResolvedUserProfileMetadataById(db, row.profile_id);
  if (provider === delegatedProfileProvider && profile?.id !== row.profile_id) {
    throw new Error("Delegated profile binding was merged");
  }
  return profile
    ? {
        profile: { profileId: profile.id, updatedAt: profile.updated_at },
        profileIds: [row.profile_id, profile.id],
      }
    : undefined;
}

/** Nonregistered profile kernels share the admitted connection; registry reads dispatch separately. */
export function readUserProfileCommand(
  db: EngineConnection,
  command: Exclude<
    Extract<OpenClawStateReadCommand, { type: `userProfiles.${string}` }>,
    RegisteredStateReadCommand
  >,
) {
  switch (command.type) {
    case "userProfiles.authenticationIdentity":
      return {
        type: command.type,
        result: runSqliteReadSnapshotSync(db, () =>
          selectExistingUserProfileAuthentication(db, command.selector),
        ),
      };
    case "userProfiles.identity":
      return {
        type: command.type,
        profile: tableExists(db, "user_profiles")
          ? runSqliteReadSnapshotSync(db, () =>
              selectUserProfileIdentityInDatabase(db, command.profileId),
            )
          : undefined,
      };
    case "userProfiles.catalogIdentity":
      return {
        type: command.type,
        result: readUserProfileCatalogIdentity(db, command.input),
      };
    case "userProfiles.githubIdentity.cached":
    case "userProfiles.githubAttribution.resolve":
      return readUserProfileGitHubCommand(db, command);
    case "userProfiles.channelIdentity.list":
      return {
        type: command.type,
        result: readUserChannelIdentityResult(() =>
          listUserChannelIdentitiesInDatabase(db, command.profileId),
        ),
      };
    case "userProfiles.channelIdentity.resolve":
      return {
        type: command.type,
        linked: resolveUserChannelIdentityInDatabase(db, command.identity),
      };
    case "userProfiles.reconcile":
    case "userProfiles.catalog":
      return readUserProfileSnapshotCommand(db, command);
    case "userProfiles.avatar.inspect":
      return runSqliteReadSnapshotSync(db, () => {
        const inspection = inspectProfileAvatarInDatabase(db, command.profileId);
        const profileId = inspection.profile?.id;
        return {
          type: command.type,
          inspection: {
            ...inspection,
            githubAvatarUrl:
              profileId && !inspection.avatar
                ? selectUserProfileGitHubIdentities(db, [profileId]).get(profileId)?.avatarUrl
                : undefined,
          },
        };
      });
    case "userProfiles.avatar.read":
      return readUserProfileAvatarCommand(db, command);
  }
  command satisfies never;
  throw new Error("Unsupported profile read command");
}
