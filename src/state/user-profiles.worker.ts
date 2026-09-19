import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { listUserProfileGitHubLogins } from "./user-profile-github-identity.js";
import { listUserProfilesSync } from "./user-profile-list.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";

export type UserProfileReadWorkerOperations = {
  "userProfiles.list": { input: undefined; output: ReturnType<typeof listUserProfilesSync> };
  "userProfiles.directory": {
    input: { limit: number };
    output: { profiles: Array<{ id: string; logins: string[] }>; truncated: boolean };
  };
};

export function executeUserProfileReadCommand(
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
