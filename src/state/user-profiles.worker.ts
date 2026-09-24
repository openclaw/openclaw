import { createHash } from "node:crypto";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { executeUserChannelIdentityChange } from "./user-channel-identities.worker.js";
import { listUserProfilesSync } from "./user-profile-identity.read.js";
import {
  executeUserProfileWrite,
  isUserProfileWriteCommand,
  type UserProfileWriteOperations,
} from "./user-profile-writes.worker.js";
import {
  selectProfileDisplayEntries,
  selectResolvedUserProfileById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import type {
  ProfileDisplayRow,
  UserProfileAvatarMime,
  UserChannelIdentityWorkerOperations,
} from "./user-profiles.types.js";

type UserProfileAvatarWorkerOperations = {
  "userProfiles.avatar.inspect": {
    input: { profileId: string };
    output: { profile: ReturnType<typeof toUserProfile> | undefined; hasAvatar: boolean };
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
    const profile = selectResolvedUserProfileById(
      openOpenClawStateDatabase(options).db,
      command.input.profileId,
    );
    return {
      profile: profile && toUserProfile(profile),
      hasAvatar: profile !== undefined && profile.avatar !== null,
    };
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

export type UserProfileWorkerOperations = {
  "userProfiles.list": { input: undefined; output: ReturnType<typeof listUserProfilesSync> };
} & UserProfileAvatarWorkerOperations &
  UserProfileWriteOperations &
  UserChannelIdentityWorkerOperations;

export function isUserProfileCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<UserProfileWorkerOperations> {
  return (
    isUserProfileWriteCommand(command) ||
    command.type === "userProfiles.list" ||
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
  if (command.type === "userProfiles.list") {
    return listUserProfilesSync(options);
  }
  return executeUserProfileAvatarCommand(command, options);
}
