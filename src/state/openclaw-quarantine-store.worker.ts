import {
  assertExistingDatabaseIdentity,
  type DatabaseFileIdentity,
} from "../infra/sqlite-worker-identity.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { currentSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { recordOpenClawDatabaseQuarantine } from "./openclaw-quarantine-store.js";
import type { WorkerOperationContext } from "./worker-operation-registry.js";

export const quarantineOperations = {
  "quarantine.record": (
    input: { pathname: string; reason: string; expectedIdentity: DatabaseFileIdentity },
    context: WorkerOperationContext,
  ) => {
    const operation = currentSqliteWorkerOperationAdmission.getStore();
    if (!operation) {
      throw new Error("Quarantine requires its retained worker admission");
    }
    const assertPhysicalSourceCurrent = operation.owner.assertPhysicalSourceCurrent;
    operation.owner.assertPhysicalSourceCurrent = () => {
      assertPhysicalSourceCurrent?.();
      assertExistingDatabaseIdentity(
        input.pathname,
        input.expectedIdentity.key,
        input.expectedIdentity.birthtime,
      );
    };
    context.open();
    recordOpenClawDatabaseQuarantine(input.pathname, input.reason, {
      env: context.stateOptions().env,
      assertCurrent: () =>
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined }),
    });
  },
};
