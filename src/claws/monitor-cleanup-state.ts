import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { ClawMonitorCleanupSnapshot } from "./monitor-cleanup.read.types.js";

export type { ClawMonitorCleanupSnapshot } from "./monitor-cleanup.read.types.js";

export async function readClawMonitorCleanupSnapshot(input: {
  agentId: string;
  storePath: string;
}): Promise<ClawMonitorCleanupSnapshot | undefined> {
  const reply = await executeExistingOpenClawStateRead(
    {},
    { type: "clawMonitorCleanup.snapshot", input },
    { current: true },
  );
  if (!reply) {
    return undefined;
  }
  if (!reply.ok || reply.type !== "clawMonitorCleanup.snapshot") {
    throw new Error("Claw monitor cleanup did not return its admitted snapshot.");
  }
  return reply.snapshot;
}

/** Cancel only while the worker holds the unchanged ownership rows and the host owns its source. */
export async function withClawMonitorCleanupSnapshot(
  input: { agentId: string; storePath: string },
  expected: ClawMonitorCleanupSnapshot,
  assertCurrent: () => void,
  cancel: () => void,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext();
  let cancelled = false;
  await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "clawProvenance.monitorCleanupGuard",
        input: { ...input, expected },
      }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" || cancelled) {
            throw new Error("Claw monitor cancellation admission requested out of order.");
          }
          context.admission.assertCurrent();
          assertCurrent();
          cancel();
          cancelled = true;
          if (!grant()) {
            throw new Error("Claw monitor cancellation lost its database admission.");
          }
        }),
      }),
    },
  );
  if (!cancelled) {
    throw new Error("Claw monitor cancellation did not receive current ownership admission.");
  }
}
