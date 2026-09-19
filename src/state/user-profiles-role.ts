import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { retainUserProfilePublication } from "./user-profile-list.js";
import {
  isUserProfileRoleAdmission,
  type UserProfileRoleAdmission,
  type UserProfileRoleMutationGuard,
} from "./user-profiles-role.types.js";
import { UserProfileNotFoundError, UserProfileOwnerError } from "./user-profiles-schema.js";

/** Ordinary Gateway role changes retain their host effects through native settlement. */
export async function changeUserProfileRole(params: {
  profileId: string;
  role: string | null;
  guard: Extract<UserProfileRoleMutationGuard, { family: "worker" }>;
  onRoleChanged: (profileId: string) => void;
  signal?: AbortSignal;
  options?: OpenClawStateDatabaseOptions;
}) {
  const { profileId, role, guard, onRoleChanged, signal, options = {} } = params;
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    signal?.throwIfAborted();
    guard.assertCurrent();
  };
  assertCurrent();
  const [
    { runOpenClawStateWorkerOperation },
    { withOpenClawStateSettlementRead },
    { createSqliteWorkerOperationAdmission },
  ] = await Promise.all([
    import("./openclaw-state-worker-store.js"),
    import("./openclaw-state-settlement-read.js"),
    import("../infra/sqlite-worker-operation-admission.js"),
  ]);
  assertCurrent();
  return withOpenClawStateSettlementRead(context, (settlementRead) =>
    runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const receipt = await scope.execute(
          {
            type: "userProfiles.setRole",
            input: { profileId, role, requesterReference: guard.requesterReference },
          },
          { signal },
        );
        if (receipt.kind === "not-found") {
          throw new UserProfileNotFoundError(profileId);
        }
        if (receipt.kind === "owner") {
          throw new UserProfileOwnerError("role");
        }
        settlementRead.acknowledge(receipt.committed);
        return receipt.profile;
      },
      {
        assertCurrent,
        createAdmission(retained) {
          let phase: "initial" | "prepared" | "transaction" | "commit" = "initial";
          let admitted: UserProfileRoleAdmission | undefined;
          let commitAdmitted = false;
          let effectsPublished = false;
          const publishRoleEffects = (changedProfileId: string) => {
            if (!effectsPublished) {
              effectsPublished = true;
              onRoleChanged(changedProfileId);
            }
          };
          return {
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              assertCurrent();
              if (
                phase === "initial" &&
                request.stage === "prepare" &&
                request.facts === "profile-role"
              ) {
                phase = "prepared";
              } else if (
                phase === "prepared" &&
                request.stage === "transaction" &&
                isUserProfileRoleAdmission(request.facts)
              ) {
                guard.assertRequester(request.facts.requester);
                admitted = request.facts;
                if (admitted.before) {
                  const before = admitted.before;
                  const publication = retainUserProfilePublication(
                    context.admission.identity,
                    before,
                    retained.settled,
                  );
                  try {
                    settlementRead.bind(
                      { type: "userProfiles.reconcile", profileId: before.id },
                      retained.settled,
                      {
                        ...publication,
                        publishCommitted(observed) {
                          publication.publishCommitted(observed);
                          publishRoleEffects(before.id);
                        },
                        onUncertain() {
                          if (commitAdmitted) {
                            publishRoleEffects(before.id);
                          }
                        },
                      },
                    );
                  } catch (error) {
                    publication.release();
                    throw error;
                  }
                }
                phase = "transaction";
              } else if (
                phase === "transaction" &&
                request.stage === "commit" &&
                admitted &&
                isDeepStrictEqual(request.facts, admitted)
              ) {
                guard.assertRequester(admitted.requester);
                phase = "commit";
              } else {
                throw new Error("Unexpected profile role transaction admission");
              }
              if (!grant()) {
                throw new Error("Profile role transaction admission expired");
              }
              if (phase === "commit") {
                commitAdmitted = true;
              }
            }),
          };
        },
      },
    ),
  );
}
