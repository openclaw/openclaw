import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { RegisteredStateReadCommand } from "./openclaw-state-read-operation-registry.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import {
  listUserChannelIdentitiesInDatabase,
  resolveUserChannelIdentityInDatabase,
} from "./user-channel-identities.js";
import { readUserChannelIdentityResult } from "./user-channel-identities.worker.js";
import { readUserProfileCatalogIdentity } from "./user-profile-catalog-identity.read.js";
import {
  readUserProfileGitHubCommand,
  selectUserProfileGitHubIdentities,
} from "./user-profile-github-identity.js";
import {
  readUserProfileSnapshotCommand,
  selectUserProfileIdentityInDatabase,
} from "./user-profile-identity.read.js";
import {
  inspectProfileAvatarInDatabase,
  readUserProfileAvatarCommand,
} from "./user-profiles-internal.js";

/** Nonregistered profile kernels share the admitted connection; registry reads dispatch separately. */
export function readUserProfileCommand(
  db: EngineConnection,
  command: Exclude<
    Extract<OpenClawStateReadCommand, { type: `userProfiles.${string}` }>,
    RegisteredStateReadCommand
  >,
) {
  switch (command.type) {
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
