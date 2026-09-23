import type { DatabaseSync } from "node:sqlite";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
  UserChannelIdentityConflictError,
  userChannelIdentitySubject,
} from "./user-channel-identities.js";
import {
  ensureUserProfilesSchema,
  UserProfileNotFoundError,
  UserProfileOwnerError,
} from "./user-profiles-schema.js";
import type {
  UserChannelIdentityResult,
  UserChannelIdentityWorkerOperations,
} from "./user-profiles.types.js";

export function readUserChannelIdentityResult<T>(operation: () => T): UserChannelIdentityResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    if (error instanceof UserChannelIdentityConflictError) {
      return { ok: false, kind: "conflict" };
    }
    if (error instanceof UserProfileNotFoundError) {
      return { ok: false, kind: "not-found" };
    }
    if (error instanceof UserProfileOwnerError) {
      return { ok: false, kind: "owner", code: error.code };
    }
    throw error;
  }
}

export function executeUserChannelIdentityChange(
  input: UserChannelIdentityWorkerOperations["userProfiles.channelIdentity.change"]["input"],
  options: OpenClawStateDatabaseOptions,
): UserChannelIdentityWorkerOperations["userProfiles.channelIdentity.change"]["output"] {
  const subject = userChannelIdentitySubject(input.identity);
  let changed = false;
  const mutationOptions = {
    ...options,
    beforeChange(db: DatabaseSync) {
      changed = true;
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { kind: "channel-identity", subject },
      });
      deferSqliteWorkerCommitReceipt(db, { kind: "channel-identity", subject });
    },
  };
  ensureUserProfilesSchema(options);
  return readUserChannelIdentityResult(() =>
    runOpenClawStateWriteTransaction(
      () => {
        const value =
          input.action === "link"
            ? {
                kind: "linked" as const,
                link: linkUserChannelIdentity(input.profileId, input.identity, mutationOptions),
              }
            : {
                kind: "unlinked" as const,
                removed: unlinkUserChannelIdentity(
                  input.profileId,
                  input.identity,
                  mutationOptions,
                ),
              };
        if (changed) {
          requestSqliteWorkerOperationAdmission({
            stage: "commit",
            facts: { kind: "channel-identity", subject },
          });
        }
        return value;
      },
      options,
      { operationLabel: "user-profiles.channel-identity-change" },
    ),
  );
}
