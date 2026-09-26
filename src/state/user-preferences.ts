import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ok, type Result } from "@openclaw/normalization-core/result";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "./openclaw-state-worker-store.js";
import {
  beginUserPreferenceMutation,
  captureUserPreferenceRead,
} from "./user-preferences-publication.js";
import {
  ensureUserPreferencesSchema,
  readUserPreferences,
  updatesGitCoauthorPreference,
  writeUserPreferences,
} from "./user-preferences.store.js";
import type {
  CanonicalUserPreferences,
  UserPreferenceCoauthorMutation,
  UserPreferenceError,
} from "./user-preferences.types.js";
import { prepareUserPreferenceUpdate } from "./user-preferences.validation.js";
import { fenceUserProfileMutationAuthority } from "./user-profile-events.js";

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

/** Read one preference for a canonical profile batch without opening SQLite on the caller. */
export async function getUserPreferenceValues(
  profileIds: readonly string[],
  key: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<{ values: Map<string, unknown>; isCurrent: () => boolean }> {
  if (profileIds.length === 0) {
    return { values: new Map(), isCurrent: () => true };
  }
  const ids = [...new Set(profileIds)];
  const context = captureOpenClawStateWorkerContext(options);
  const isCurrent = await captureUserPreferenceRead(context.admission);
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "userPreferences.values", profileIds: ids, key },
    { context, current: true },
  );
  if (reply && (!reply.ok || reply.type !== "userPreferences.values")) {
    throw new Error(reply.ok ? "Unexpected user preference values reply" : reply.message);
  }
  return { values: reply?.values ?? new Map(), isCurrent };
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
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    assertCurrent?: () => void;
    expectedEntries?: Record<string, unknown>;
  } = {},
): Promise<Result<{ profileId: string }, UserPreferenceError> | undefined> {
  const prepared = prepareUserPreferenceUpdate(entries, options.expectedEntries);
  if (!prepared.ok) {
    return prepared;
  }
  const context = captureOpenClawStateWorkerContext(options);
  const finishMutation = beginUserPreferenceMutation(context.admission);
  let publicationSettled: Promise<void> | undefined;
  try {
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "userPreferences.write",
          input: { profileId, update: prepared.value },
        }),
      {
        assertCurrent: options.assertCurrent,
        createAdmission: (operation) => {
          let stage: "transaction" | "commit" | "complete" = "transaction";
          let pending:
            | {
                facts: UserPreferenceCoauthorMutation;
                fence: ReturnType<typeof fenceUserProfileMutationAuthority>;
                granted: boolean;
              }
            | undefined;
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            context.admission.assertCurrent();
            options.assertCurrent?.();
            if (
              stage === "transaction" &&
              request.stage === "transaction" &&
              request.facts === undefined
            ) {
              stage = "commit";
              grant();
              return;
            }
            if (stage !== "commit" || request.stage !== "commit") {
              throw new Error("Profile preference mutation requires transaction admission");
            }
            stage = "complete";
            if (request.facts === undefined) {
              grant();
              return;
            }
            if (
              !updatesGitCoauthorPreference(prepared.value) ||
              !isRecord(request.facts) ||
              request.facts.kind !== "user-preference-coauthor" ||
              typeof request.facts.profileId !== "string" ||
              request.facts.profileId.length === 0
            ) {
              throw new Error("Profile preference mutation returned invalid authority facts");
            }
            const facts: UserPreferenceCoauthorMutation = {
              kind: "user-preference-coauthor",
              profileId: request.facts.profileId,
            };
            pending = {
              facts,
              fence: fenceUserProfileMutationAuthority(context.admission, {
                profiles: [facts.profileId],
                identities: [],
                channels: [],
              }),
              granted: false,
            };
            pending.granted = grant();
          });
          publicationSettled = operation.settled.then((settlement) => {
            let committed = false;
            let receiptValid = false;
            try {
              const receipt = admission.committed;
              if (receipt) {
                if (!pending || !isDeepStrictEqual(receipt.facts, pending.facts)) {
                  throw new Error("Profile preference receipt changed its prepared mutation");
                }
                committed = true;
              }
              receiptValid = true;
            } finally {
              pending?.fence.settle(
                !pending.granted || committed || (receiptValid && settlement.kind === "completed"),
              );
            }
          });
          void publicationSettled.catch(() => undefined);
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    );
  } finally {
    // Caller revocation cannot discard a committed preference change or its authority fence.
    try {
      await publicationSettled;
    } finally {
      finishMutation();
    }
  }
}
