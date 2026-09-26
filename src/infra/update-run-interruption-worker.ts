import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { InterruptedUpdateSettlement } from "./update-run-interruption-contract.js";

export async function readInterruptedUpdateCandidateAsync(options: UpdateRunLedgerOptions) {
  const reply = await withArtifactPreservingStateReads(() =>
    executeExistingOpenClawStateRead(options, { type: "updateRuns.interruptedCandidate" }),
  );
  if (!reply) {
    return undefined;
  }
  if (!reply.ok || reply.type !== "updateRuns.interruptedCandidate") {
    throw new Error("Unexpected interrupted update lookup result");
  }
  return reply.run;
}

export function persistInterruptedUpdateObservationAsync(
  context: OpenClawStateWorkerContext,
  input: InterruptedUpdateSettlement,
  signal?: AbortSignal,
) {
  const assertCurrent = () => {
    context.admission.assertCurrent();
    signal?.throwIfAborted();
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "updateRuns.reconcileInterrupted", input }),
    {
      existingOnly: true,
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}
