import {
  retrySqliteWorkerAdmission,
  SQLITE_WORKER_ADMISSION_DEADLINE_MS,
} from "../infra/sqlite-worker-admission-retry.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
  UserChannelIdentityConflictError,
  userChannelIdentitySubject,
  authorizeUserChannelIdentityInDatabase,
  publishUserChannelPolicyInDatabase,
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

const CHANNEL_IDENTITY_ADMISSION_ATTEMPTS = 3;

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
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): UserChannelIdentityWorkerOperations["userProfiles.channelIdentity.change"]["output"] {
  const subject = "identity" in input ? userChannelIdentitySubject(input.identity) : undefined;
  if (input.action !== "policy") {
    ensureUserProfilesSchema(options);
  }
  return retrySqliteWorkerAdmission(
    () => {
      const profiles: string[] = [];
      const facts = {
        kind: "channel-identity",
        action: input.action,
        subject,
        profiles,
        channels: subject === undefined ? [] : [subject],
      };
      let changed = false;
      const mutationOptions = {
        ...options,
        beforeChange() {
          changed = true;
        },
      };
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts,
        deadlineMs: SQLITE_WORKER_ADMISSION_DEADLINE_MS,
      });
      return readUserChannelIdentityResult(() =>
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            if (input.action === "policy" || input.action === "authorize") {
              mutationOptions.beforeChange();
            }
            if (input.action === "policy") {
              Object.assign(
                facts,
                publishUserChannelPolicyInDatabase(db, input.policy, input.configuredOwnersHash),
              );
            }
            const value =
              input.action === "policy"
                ? { kind: "policy" as const }
                : input.action === "authorize"
                  ? {
                      kind: "authorized" as const,
                      reference: authorizeUserChannelIdentityInDatabase(db, input),
                    }
                  : input.action === "link"
                    ? {
                        kind: "linked" as const,
                        link: linkUserChannelIdentity(
                          input.profileId,
                          input.identity,
                          mutationOptions,
                        ),
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
                facts,
                deadlineMs: SQLITE_WORKER_ADMISSION_DEADLINE_MS,
              });
              deferSqliteWorkerCommitReceipt(db, facts);
            }
            return value;
          },
          options,
          { operationLabel: "user-profiles.channel-identity-change" },
        ),
      );
    },
    {
      maxAttempts: CHANNEL_IDENTITY_ADMISSION_ATTEMPTS,
      database: options.database.db,
      exhaustedMessage: `Channel identity ${input.action} could not obtain database admission after ${CHANNEL_IDENTITY_ADMISSION_ATTEMPTS} attempts. Check \`openclaw gateway status --deep\`, then retry the operation.`,
    },
  );
}
