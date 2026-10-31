import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { recordOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import type { WorkerOperationContext } from "./worker-operation-registry.js";

export const quarantineOperations = {
  "quarantine.record": (
    input: { pathname: string; reason: string },
    context: WorkerOperationContext,
  ) => {
    context.open();
    recordOpenClawDatabaseQuarantine(input.pathname, input.reason, {
      env: context.stateOptions().env,
      assertCurrent: () =>
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined }),
    });
  },
};
