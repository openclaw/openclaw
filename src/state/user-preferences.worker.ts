import { ok } from "@openclaw/normalization-core/result";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
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
import type { WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const userPreferenceOperations = {
  "userPreferences.write": (
    input: UserPreferenceWorkerOperations["userPreferences.write"]["input"],
    context: WorkerWriteOperationContext,
  ): UserPreferenceWorkerOperations["userPreferences.write"]["output"] => {
    const database = context.open();
    const options = { ...context.stateOptions(), database };
    ensureUserProfilesSchema(options);
    const { update } = input;
    if (
      update.serialized.length === 0 &&
      update.deletionKeys.length === 0 &&
      update.expected.length === 0
    ) {
      const profile = selectResolvedUserProfileMetadataById(database.db, input.profileId);
      return profile ? ok({ profileId: profile.id }) : undefined;
    }
    ensureUserPreferencesSchema(options);
    return context.write(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const profile = selectResolvedUserProfileMetadataById(db, input.profileId);
        if (!profile) {
          return undefined;
        }
        const result = writeUserPreferences(db, profile.id, update);
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
      { operationLabel: "users.preferences.set" },
    );
  },
};
