import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

export function secretStoreWriteAdmission(
  context: OpenClawStateWorkerContext,
  assertCallerCurrent?: () => void,
) {
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertCallerCurrent?.();
  };
  return {
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
      context.admission.databasePath,
    ]),
  };
}
