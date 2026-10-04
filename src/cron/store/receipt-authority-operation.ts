import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../../state/openclaw-state-worker-store.types.js";
import { withCronReceiptAuthorityMutation } from "./receipt-authority-owner.js";

/** Store saves may perform several repair transactions within one retained operation. */
export function runCronStoreAuthorityOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: (scope: DomainScope) => Promise<T>,
): Promise<T> {
  return withCronReceiptAuthorityMutation(context, (mutation) =>
    runOpenClawStateWorkerOperation(mutation.context, operation, {
      assertCurrent: mutation.assertCurrent,
      createAdmission(retained) {
        const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
          mutation.assertCurrent();
          if (!grant()) {
            throw new Error("Cron store publication admission expired");
          }
        }, mutation.attachment);
        mutation.observe(admission, retained);
        return { admission, nativeLocations: [context.admission.databasePath] };
      },
    }),
  );
}
