import { createHash } from "node:crypto";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { executeUserChannelIdentityChange } from "./user-channel-identities.worker.js";
import { selectStoredGitHubIdentities } from "./user-profile-github-identity.js";
import { listUserProfilesSync } from "./user-profile-identity.read.js";
import {
  executeUserProfileWrite,
  isUserProfileWriteCommand,
  type UserProfileWriteOperations,
} from "./user-profile-writes.worker.js";
import {
  selectProfileDisplayEntries,
  inspectProfileAvatarInDatabase,
  selectResolvedUserProfileById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import type {
  ProfileDisplayRow,
  UserProfileAvatarMime,
  UserChannelIdentityWorkerOperations,
} from "./user-profiles.types.js";

type UserProfileReadWorkerOperations = {
  "userProfiles.list": { input: undefined; output: ReturnType<typeof listUserProfilesSync> };
  "userProfiles.directory": {
    input: { limit: number };
    output: { profiles: Array<{ id: string; logins: string[] }>; truncated: boolean };
  };
};

function executeUserProfileReadCommand(
  command: SqliteWorkerCommand<UserProfileReadWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): UserProfileReadWorkerOperations[keyof UserProfileReadWorkerOperations]["output"] {
  if (command.type === "userProfiles.list") {
    return listUserProfilesSync(options);
  }
  const database = openOpenClawStateDatabase(options);
  ensureUserProfilesSchema(options, database);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const profiles = executeSqliteQuerySync(
        database.db,
        userProfilesDb(database.db)
          .selectFrom("user_profiles")
          .select("id")
          .where("merged_into", "is", null)
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .limit(command.input.limit + 1),
      ).rows;
      const selected = profiles.slice(0, command.input.limit);
      const identities = selectStoredGitHubIdentities(
        database.db,
        selected.map(({ id }) => id),
      );
      return {
        profiles: selected.map(({ id }) => ({
          id,
          logins: identities.get(id)?.accounts.map((account) => account.login) ?? [],
        })),
        truncated: profiles.length > command.input.limit,
      };
    },
    { databaseLabel: database.path, operationLabel: "user-profiles.directory" },
  );
}

type UserProfileAvatarWorkerOperations = {
  "userProfiles.avatar.inspect": {
    input: { profileId: string };
    output: ReturnType<typeof inspectProfileAvatarInDatabase>;
  };
  "userProfiles.avatar.adopt": {
    input: { profileId: string; bytes: Uint8Array; mime: UserProfileAvatarMime; now: number };
    output: {
      profile: ReturnType<typeof toUserProfile> | undefined;
      committed?: ProfileDisplayRow;
    };
  };
};

function executeUserProfileAvatarCommand(
  command: SqliteWorkerCommand<UserProfileAvatarWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): UserProfileAvatarWorkerOperations[keyof UserProfileAvatarWorkerOperations]["output"] {
  if (command.type === "userProfiles.avatar.inspect") {
    return inspectProfileAvatarInDatabase(
      openOpenClawStateDatabase(options).db,
      command.input.profileId,
    );
  }
  const { input } = command;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = selectResolvedUserProfileById(db, input.profileId);
      if (!profile) {
        return { profile: undefined };
      }
      if (profile.avatar !== null) {
        return { profile: toUserProfile(profile) };
      }
      const before = selectProfileDisplayEntries(db, [profile.id])[0]![1];
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { kind: "profile-avatar", before },
      });
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({
            avatar: input.bytes,
            avatar_mime: input.mime,
            avatar_sha256: sha256,
            updated_at: input.now,
          })
          .where("id", "=", profile.id),
      );
      const committed = selectProfileDisplayEntries(db, [profile.id])[0]![1];
      return {
        profile: toUserProfile({ ...profile, avatar_mime: input.mime, updated_at: input.now }),
        committed,
      };
    },
    options,
    { operationLabel: "user-profiles.adopt-avatar" },
  );
}

export type UserProfileWorkerOperations = UserProfileReadWorkerOperations &
  UserProfileAvatarWorkerOperations &
  UserProfileWriteOperations &
  UserChannelIdentityWorkerOperations;

export function isUserProfileCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<UserProfileWorkerOperations> {
  return (
    isUserProfileWriteCommand(command) ||
    command.type === "userProfiles.list" ||
    command.type === "userProfiles.directory" ||
    command.type === "userProfiles.channelIdentity.change" ||
    command.type === "userProfiles.avatar.inspect" ||
    command.type === "userProfiles.avatar.adopt"
  );
}

export function executeUserProfileCommand(
  command: SqliteWorkerCommand<UserProfileWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): UserProfileWorkerOperations[keyof UserProfileWorkerOperations]["output"] {
  if (isUserProfileWriteCommand(command)) {
    return executeUserProfileWrite(command, options);
  }
  if (command.type === "userProfiles.channelIdentity.change") {
    return executeUserChannelIdentityChange(command.input, options);
  }
  if (command.type === "userProfiles.list" || command.type === "userProfiles.directory") {
    return executeUserProfileReadCommand(command, options);
  }
  return executeUserProfileAvatarCommand(command, options);
}
