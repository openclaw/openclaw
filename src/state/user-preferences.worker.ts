import { ok } from "@openclaw/normalization-core/result";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  ensureUserPreferencesSchema,
  updatesGitCoauthorPreference,
  writeUserPreferences,
} from "./user-preferences.store.js";
import type {
  UserPreferenceCoauthorMutation,
  UserPreferenceWorkerOperations,
} from "./user-preferences.types.js";
import { selectResolvedUserProfileMetadataById } from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";

export function executeUserPreferenceCommand(
  command: SqliteWorkerCommand<UserPreferenceWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): UserPreferenceWorkerOperations[keyof UserPreferenceWorkerOperations]["output"] {
  ensureUserProfilesSchema(options);
  const { update } = command.input;
  if (
    update.serialized.length === 0 &&
    update.deletionKeys.length === 0 &&
    update.expected.length === 0
  ) {
    const profile = selectResolvedUserProfileMetadataById(
      openOpenClawStateDatabase(options).db,
      command.input.profileId,
    );
    return profile ? ok({ profileId: profile.id }) : undefined;
  }
  ensureUserPreferencesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const profile = selectResolvedUserProfileMetadataById(db, command.input.profileId);
      if (!profile) {
        return undefined;
      }
      const result = writeUserPreferences(db, profile.id, command.input.update);
      const facts: UserPreferenceCoauthorMutation | undefined =
        result.ok && updatesGitCoauthorPreference(update)
          ? { kind: "user-preference-coauthor", profileId: profile.id }
          : undefined;
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts });
      if (facts) {
        deferSqliteWorkerCommitReceipt(db, facts);
      }
      return result.ok ? ok({ profileId: profile.id }) : result;
    },
    options,
    { operationLabel: "users.preferences.set" },
  );
}
