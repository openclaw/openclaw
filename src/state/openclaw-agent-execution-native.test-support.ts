import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { AgentDatabaseExecutionLifetime } from "./openclaw-agent-execution-authority.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";

// Direct native fixtures hold their generation until their explicit close.
export function createNativeIntegrityGeneration(
  database: { agentId: string; path: string },
  context: Parameters<typeof createAgentDatabaseNativeGeneration>[2],
  assertCurrent = () => context.admission.assertCurrent(),
  assertCleanup = assertCurrent,
) {
  const generation = createAgentDatabaseNativeGeneration(
    database.agentId,
    database.path,
    context,
    new AgentDatabaseExecutionLifetime().state,
    assertCurrent,
    assertCleanup,
    undefined,
    () => {},
    () => {},
  );
  return Object.assign(generation, {
    source: createNativeIntegritySource(assertCurrent),
    [Symbol.asyncDispose]: () => generation.close(),
  });
}

export function createNativeIntegritySource(
  assertCurrent: () => void,
  beforeGrant?: (request: SqliteWorkerAdmissionRequest) => void,
): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent,
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        assertCurrent();
        beforeGrant?.(request);
        if (!grant()) {
          throw new Error("Native integrity fixture lost its retained admission");
        }
      }, binding.attachment),
    }),
  };
}
