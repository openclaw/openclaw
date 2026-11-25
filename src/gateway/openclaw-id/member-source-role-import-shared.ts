import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runCronRuntimeMutation } from "../../cron/service/runtime-mutation.js";
import { noteCronJobsStoreCommit, publishCronJobsStoreMutation } from "../../cron/store.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import { observeSqliteWorkerAdmissionFinish } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { operatorStandingGrantPublication } from "../operator-approval-store.publication.js";
import { migrateWorkerEnvironmentMemberSources } from "../worker-environments/store.js";
import type { LegacyOpenClawIdMemberRoleImport } from "./member-source-role-import.js";

/** Source owners settle before the caller commits the imported profile role. */
export async function migrateSharedOpenClawIdMemberSources(
  input: LegacyOpenClawIdMemberRoleImport,
  assertCurrent: () => void,
): Promise<void> {
  const captured = structuredClone(input);
  const context = captureOpenClawStateWorkerContext();
  const check = () => {
    context.admission.assertCurrent();
    assertCurrent();
  };
  check();
  const createAdmission: SqliteWorkerAdmissionFactory = (operation) => {
    let commitAdmitted = false;
    const retained = createSqliteWorkerWriteAdmission(
      (request) => {
        check();
        if (request.stage === "commit") {
          commitAdmitted = true;
        }
      },
      [context.admission.databasePath],
    )(operation);
    const publication = operatorStandingGrantPublication.begin({
      identity: context.admission.identity.key,
      assertCurrent: context.assertPublicationCurrent ?? context.admission.assertCurrent,
    });
    observeSqliteWorkerCommittedFacts(retained.admission, ({ facts }) => {
      publication.committed(isRecord(facts) ? facts.standingGrantFacts : undefined);
    });
    observeSqliteWorkerAdmissionFinish(retained.admission, () => {
      const confirmed = retained.admission.settlement?.kind === "completed";
      publication.finish(confirmed, confirmed && !retained.admission.committed && !commitAdmitted);
    });
    return retained;
  };
  await runCronRuntimeMutation({
    context,
    type: "cron.importLegacyMemberSources",
    input: captured,
    snapshot: {},
    assertCurrent: check,
    createAdmission,
    publish: ({ storeKeys }) => storeKeys.forEach((key) => publishCronJobsStoreMutation(key)),
    onSettled: (outcome) => {
      if (outcome === "unknown") {
        noteCronJobsStoreCommit();
      }
    },
  });
  await migrateWorkerEnvironmentMemberSources(context, captured, check);
  check();
}
