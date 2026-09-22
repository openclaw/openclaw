import { ok, type Result } from "@openclaw/normalization-core/result";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "./openclaw-state-worker-store.js";
import {
  ensureUserPreferencesSchema,
  readUserPreferences,
  writeUserPreferences,
} from "./user-preferences.store.js";
import type { CanonicalUserPreferences, UserPreferenceError } from "./user-preferences.types.js";
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
  options: OpenClawStateDatabaseOptions = {},
): Result<void, UserPreferenceError> {
  const prepared = prepareUserPreferenceUpdate(entries);
  if (!prepared.ok) {
    return prepared;
  }
  if (prepared.value.serialized.length === 0 && prepared.value.deletionKeys.length === 0) {
    return ok(undefined);
  }
  ensureUserPreferencesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => writeUserPreferences(db, profileId, prepared.value),
    options,
    { operationLabel: "users.preferences.set" },
  );
}

export function getCanonicalUserPreferences(
  profileId: string,
  keys?: readonly string[],
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<CanonicalUserPreferences | undefined> {
  return executeOpenClawStateWorker(captureOpenClawStateWorkerContext(options), {
    type: "userPreferences.read",
    input: { profileId, keys },
  });
}

export async function setCanonicalUserPreferences(
  profileId: string,
  entries: Record<string, unknown>,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<Result<{ profileId: string }, UserPreferenceError> | undefined> {
  const prepared = prepareUserPreferenceUpdate(entries);
  if (!prepared.ok) {
    return prepared;
  }
  return executeOpenClawStateWorker(captureOpenClawStateWorkerContext(options), {
    type: "userPreferences.write",
    input: { profileId, update: prepared.value },
  });
}
