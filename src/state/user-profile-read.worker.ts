import type { DatabaseSync } from "node:sqlite";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";
import {
  listUserChannelIdentitiesInDatabase,
  resolveUserChannelIdentityInDatabase,
} from "./user-channel-identities.js";
import { readUserChannelIdentityResult } from "./user-channel-identities.worker.js";
import { readUserProfileCatalogIdentity } from "./user-profile-catalog-identity.read.js";
import { readUserProfileGitHubCommand } from "./user-profile-github-identity.js";
import {
  readCurrentUserProfileAliasesInDatabase,
  readUserProfileAuthorityCommand,
  readUserProfileIdForEmail,
  readUserProfileSnapshotCommand,
} from "./user-profile-identity.read.js";
import { readUserProfileAvatarCommand } from "./user-profiles-internal.js";

/** Profile read kernels share the caller's admitted worker connection and error owner. */
export function readUserProfileCommand(
  db: DatabaseSync,
  command: Extract<OpenClawStateReadCommand, { type: `userProfiles.${string}` }>,
): Extract<OpenClawStateReadResult, { type: `userProfiles.${string}` }> {
  switch (command.type) {
    case "userProfiles.authority.resolve":
      return readUserProfileAuthorityCommand(db, command);
    case "userProfiles.aliases.resolve":
      return {
        type: command.type,
        ...readCurrentUserProfileAliasesInDatabase(db, command.profileId),
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
    case "userProfiles.avatar.read":
      return readUserProfileAvatarCommand(db, command);
    case "userProfiles.email.resolve":
      return {
        type: command.type,
        profileId: runSqliteDeferredTransactionSync(db, () =>
          readUserProfileIdForEmail(db, command.email),
        ),
      };
  }
  command satisfies never;
  throw new Error("Unsupported profile read command");
}
