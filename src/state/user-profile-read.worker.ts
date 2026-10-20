import type { EngineConnection } from "../infra/sql-connection.js";
import type { OpenClawStateReadCommand } from "./openclaw-state-read.types.js";
import {
  listUserChannelIdentitiesInDatabase,
  resolveUserChannelIdentityInDatabase,
} from "./user-channel-identities.js";
import { readUserChannelIdentityResult } from "./user-channel-identities.worker.js";
import { readUserProfileCatalogIdentity } from "./user-profile-catalog-identity.read.js";
import { readUserProfileGitHubCommand } from "./user-profile-github-identity.js";
import { readUserProfileSnapshotCommand } from "./user-profile-identity.read.js";
import { readUserProfileAvatarCommand } from "./user-profiles-internal.js";

/** Profile read kernels share the caller's admitted worker connection and error owner. */
export function readUserProfileCommand(
  db: EngineConnection,
  command: Extract<OpenClawStateReadCommand, { type: `userProfiles.${string}` }>,
) {
  switch (command.type) {
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
    case "userProfiles.avatar.read":
      return readUserProfileAvatarCommand(db, command);
  }
  command satisfies never;
  throw new Error("Unsupported profile read command");
}
