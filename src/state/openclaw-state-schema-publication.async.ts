import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import type { StateSchemaPublicationBlocker } from "./openclaw-state-schema-publication.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";

/** Publish deferred schema metadata through the existing shared-state writer. */
export function reconcileOpenClawStateSchemaPublicationAsync(
  options: { path?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<StateSchemaPublicationBlocker | undefined> {
  const context = captureOpenClawStateWorkerContext(options);
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "database.publishSchema", input: undefined }),
    {
      existingOnly: true,
      signal: options.signal,
      createAdmission: createSqliteWorkerWriteAdmission(context.admission.assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}
