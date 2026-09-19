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
import { listUserProfileGitHubLogins } from "./user-profile-github-identity.js";
import { listUserProfilesSync } from "./user-profile-list.js";
import {
  selectProfileDisplayEntries,
  selectResolvedUserProfileById,
  selectResolvedUserProfileMetadataById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { writeUserProfileRole } from "./user-profiles-role.kernel.js";
import type { UserProfileRoleAdmission } from "./user-profiles-role.types.js";
import {
  ensureUserProfilesSchema,
  ensureUserProfileRoleSchema,
  UserProfileNotFoundError,
  UserProfileOwnerError,
} from "./user-profiles-schema.js";
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

type RoleWriteResult =
  | {
      kind: "committed";
      profile: ReturnType<typeof writeUserProfileRole>;
      committed: ProfileDisplayRow;
    }
  | { kind: "not-found" }
  | { kind: "owner" };

type UserProfileRoleWorkerOperations = {
  "userProfiles.setRole": {
    input: { profileId: string; role: string | null; requesterReference: string | null };
    output: RoleWriteResult;
  };
};

function executeUserProfileRoleCommand(
  command: SqliteWorkerCommand<UserProfileRoleWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): RoleWriteResult {
  const { input } = command;
  return runOpenClawStateWriteTransaction(
    (database) => {
      requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: "profile-role" });
      ensureUserProfileRoleSchema(options, database);
      const { db } = database;
      const requester = input.requesterReference
        ? selectResolvedUserProfileMetadataById(db, input.requesterReference)
        : undefined;
      let admission: UserProfileRoleAdmission = {
        kind: "profile-role",
        requester: {
          profileId: requester?.id ?? null,
          assignedRole: requester?.role ?? null,
        },
      };
      let result: RoleWriteResult;
      try {
        const profile = writeUserProfileRole(
          db,
          input.profileId,
          input.role,
          Date.now(),
          (profileId) => {
            admission = {
              ...admission,
              before: selectProfileDisplayEntries(db, [profileId])[0]![1],
            };
            requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: admission });
          },
        );
        result = {
          kind: "committed",
          profile,
          committed: selectProfileDisplayEntries(db, [profile.id])[0]![1],
        };
      } catch (error) {
        if (
          !(error instanceof UserProfileNotFoundError || error instanceof UserProfileOwnerError)
        ) {
          throw error;
        }
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: admission });
        result = { kind: error instanceof UserProfileNotFoundError ? "not-found" : "owner" };
      }
      // The requester's preimage keeps a legitimate self-downgrade authorized through commit.
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: admission });
      return result;
    },
    options,
    { operationLabel: "user-profiles.set-role" },
  );
}

export type UserProfileWorkerOperations = UserProfileReadWorkerOperations &
  UserProfileAvatarWorkerOperations &
  UserProfileRoleWorkerOperations;

export function executeUserProfileCommand(
  command: SqliteWorkerCommand<UserProfileWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): UserProfileWorkerOperations[keyof UserProfileWorkerOperations]["output"] {
  if (command.type === "userProfiles.setRole") {
    return executeUserProfileRoleCommand(command, options);
  }
  if (
    command.type === "userProfiles.avatar.inspect" ||
    command.type === "userProfiles.avatar.adopt"
  ) {
    return executeUserProfileAvatarCommand(command, options);
  }
  return executeUserProfileReadCommand(command, options);
}
