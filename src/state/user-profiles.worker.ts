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
import { ensureProfileForEmailInDatabase } from "./user-profile-email.kernel.js";
import { listUserProfileGitHubLogins } from "./user-profile-github-identity.js";
import { listUserProfilesSync } from "./user-profile-list.js";
import {
  selectProfileDisplayEntries,
  selectResolvedUserProfileById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import type { ProfileDisplayRow, UserProfileAvatarMime } from "./user-profiles.types.js";

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
      const profiles = listUserProfilesSync(options).filter(
        (profile) => profile.mergedInto === null,
      );
      const logins = listUserProfileGitHubLogins(options);
      return {
        profiles: profiles
          .slice(0, command.input.limit)
          .map(({ id }) => ({ id, logins: logins.get(id) ?? [] })),
        truncated: profiles.length > command.input.limit,
      };
    },
    { databaseLabel: database.path, operationLabel: "user-profiles.directory" },
  );
}

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

export type UserProfileWorkerOperations = UserProfileReadWorkerOperations &
  UserProfileAvatarWorkerOperations & {
    "userProfiles.email.ensure": {
      input: { email: string };
      output: { profileId: string; committed?: ProfileDisplayRow };
    };
  };

export function executeUserProfileCommand(
  command: SqliteWorkerCommand<UserProfileWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): UserProfileWorkerOperations[keyof UserProfileWorkerOperations]["output"] {
  if (command.type === "userProfiles.email.ensure") {
    ensureUserProfilesSchema(options);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        let created = false;
        const profile = ensureProfileForEmailInDatabase(
          db,
          command.input.email,
          null,
          Date.now(),
          (profileId) => {
            requestSqliteWorkerOperationAdmission({
              stage: "transaction",
              facts: { kind: "profile-create", profileId },
            });
            created = true;
          },
        );
        const committed = created
          ? selectProfileDisplayEntries(db, [profile.id])[0]![1]
          : undefined;
        if (created) {
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        }
        return { profileId: profile.id, committed };
      },
      options,
      { operationLabel: "user-profiles.ensure" },
    );
  }
  if (command.type === "userProfiles.list" || command.type === "userProfiles.directory") {
    return executeUserProfileReadCommand(command, options);
  }
  return executeUserProfileAvatarCommand(command, options);
}
