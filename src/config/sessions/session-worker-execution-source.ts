import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";

export function createSessionWorkerExecutionSource(
  assertCurrent: () => void,
  expiredMessage: string,
): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertCurrent();
          if (!grant()) {
            throw new Error(expiredMessage);
          }
        }, binding.attachment),
      });
    },
  };
}
