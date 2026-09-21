import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { withOpenClawStateSettlementRead } from "./openclaw-state-settlement-read.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { normalizeProfileEmail } from "./user-profile-email.kernel.js";
import { retainUserProfilePublication } from "./user-profile-list.js";

/** Legacy email authentication keeps creation with the existing profile owner. */
export async function ensureProfileIdForEmail(
  email: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
  assertCurrent?: () => void,
): Promise<string> {
  assertCurrent?.();
  const normalized = normalizeProfileEmail(email);
  const context = captureOpenClawStateWorkerContext(options);
  const selected = { ...options, path: context.admission.databasePath };
  const observed = await executeExistingOpenClawStateRead(selected, {
    type: "userProfiles.email.resolve",
    email: normalized,
  });
  context.admission.assertCurrent();
  assertCurrent?.();
  if (observed && (!observed.ok || observed.type !== "userProfiles.email.resolve")) {
    throw new Error("Unexpected profile email lookup reply");
  }
  if (observed?.profileId) {
    return observed.profileId;
  }
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
  return withOpenClawStateSettlementRead(context, (settlementRead) =>
    runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const result = await scope.execute({
          type: "userProfiles.email.ensure",
          input: { email: normalized },
        });
        settlementRead.acknowledge(result.committed);
        return result.profileId;
      },
      {
        assertCurrent,
        createAdmission(retained) {
          return {
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              context.admission.assertCurrent();
              assertCurrent?.();
              if (request.stage === "commit") {
                grant();
                return;
              }
              if (
                request.stage !== "transaction" ||
                !isRecord(request.facts) ||
                request.facts.kind !== "profile-create" ||
                typeof request.facts.profileId !== "string"
              ) {
                throw new Error("Unexpected profile creation admission");
              }
              const publication = retainUserProfilePublication(
                context.admission.identity,
                request.facts.profileId,
                undefined,
              );
              try {
                settlementRead.bind(
                  { type: "userProfiles.reconcile", profileId: request.facts.profileId },
                  retained.settled,
                  publication.reconcile,
                  publication.release,
                );
              } catch (error) {
                publication.release();
                throw error;
              }
              grant();
            }),
          };
        },
      },
    ),
  );
}
