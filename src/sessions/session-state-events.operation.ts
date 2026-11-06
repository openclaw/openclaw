import { assertSessionEntriesCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import type { SessionEntriesCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";

export type SessionWatchOptions = Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
  now?: number;
  assertCurrent?: () => void;
  sessionEntriesCurrent?: SessionEntriesCurrentCheck;
};

export function runSessionWatchOperation<T>(
  context: OpenClawStateWorkerContext,
  operation: Parameters<typeof runOpenClawStateWorkerOperation<T>>[1],
  assertCurrent: () => void,
  sessionEntriesCurrent?: SessionEntriesCurrentCheck,
): Promise<T> {
  return runOpenClawStateWorkerOperation(context, operation, {
    assertCurrent,
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        if (
          request.stage !== "prepare" &&
          request.stage !== "transaction" &&
          request.stage !== "commit"
        ) {
          throw new Error("Session watch operation requires worker admission");
        }
        context.admission.assertCurrent();
        assertSessionEntriesCurrentAdmission(request, sessionEntriesCurrent);
        assertCurrent();
        grant();
      }),
    }),
  });
}
