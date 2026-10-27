import { ok, type Result } from "@openclaw/normalization-core/result";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  ensureUserPreferencesSchema,
  readUserPreferences,
  writeUserPreferences,
} from "./user-preferences.store.js";
import type { UserPreferenceError } from "./user-preferences.types.js";
import { prepareUserPreferenceUpdate } from "./user-preferences.validation.js";

export function getUserPreferences(
  profileId: string,
  keys?: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Record<string, unknown> {
  if (keys?.length === 0) {
    return {};
  }
  ensureUserPreferencesSchema(options);
  return readUserPreferences(openOpenClawStateDatabase(options).db, profileId, keys);
}

export function setUserPreferences(
  profileId: string,
  entries: Record<string, unknown>,
  options: OpenClawStateDatabaseOptions & { expectedEntries?: Record<string, unknown> } = {},
): Result<void, UserPreferenceError> {
  const prepared = prepareUserPreferenceUpdate(entries, options.expectedEntries);
  if (!prepared.ok) {
    return prepared;
  }
  if (
    prepared.value.serialized.length === 0 &&
    prepared.value.deletionKeys.length === 0 &&
    prepared.value.expected.length === 0
  ) {
    return ok(undefined);
  }
  ensureUserPreferencesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => writeUserPreferences(db, profileId, prepared.value),
    options,
    { operationLabel: "users.preferences.set" },
  );
}
