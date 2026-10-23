import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateReadCommand } from "../state/openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { formatErrorMessage } from "./errors.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { canReconcileUpdateRunCandidates } from "./update-run-read.kernel.js";
import type {
  UpdateRunReconciliationCandidate,
  UpdateRunReconciliationInput,
  UpdateRunReconciliationResult,
} from "./update-run-reconciliation.types.js";
import type { UpdateRunRecord } from "./update-run-record.js";

type ReconciliationOptions = UpdateRunLedgerOptions & {
  signal?: AbortSignal;
  /** Relocation-capable callers must not retain readers on the live database. */
  snapshot?: true;
};

function prepareReconciliation(options: ReconciliationOptions) {
  const captured = {
    ...options,
    signal: options.signal ?? getAsyncWorkSignal(),
    env: cloneEnvWithPlatformSemantics(options.env ?? process.env),
    ...(options.redactPaths ? { redactPaths: [...options.redactPaths] } : {}),
  };
  const context = captureOpenClawStateWorkerContext(captured);
  captured.path = context.admission.databasePath;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    captured.signal?.throwIfAborted();
  };
  assertCurrent();
  return {
    options: captured,
    context,
    assertCurrent,
    async read<Command extends OpenClawStateReadCommand>(command: Command) {
      const reply = await withArtifactPreservingStateReads(() =>
        executeExistingOpenClawStateRead(captured, command, {
          context,
          signal: captured.signal,
          preferIndependentWarmRead: captured.snapshot ? undefined : true,
        }),
      );
      assertCurrent();
      return reply;
    },
  };
}

type Reconciliation = ReturnType<typeof prepareReconciliation>;

async function reconcileCandidates(
  candidates: UpdateRunReconciliationCandidate[],
  selection: UpdateRunReconciliationInput,
  prepared: Reconciliation,
): Promise<UpdateRunReconciliationResult> {
  prepared.assertCurrent();
  if (
    !canReconcileUpdateRunCandidates(candidates, selection) &&
    selection.repairHistorySinceMs === undefined
  ) {
    return { current: candidates.map(({ record }) => record), reconciled: [] };
  }
  const { context, options, assertCurrent } = prepared;
  if (options.database || options.readOnly) {
    throw new Error("Existing-state writes require their own tracked writable connection.");
  }
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "updateRuns.reconcile",
        input: {
          candidates,
          selection,
          busyTimeoutMs: options.busyTimeoutMs,
          redactPaths: options.redactPaths,
        },
      }),
    {
      existingOnly: true,
      signal: options.signal,
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
  if (!result) {
    throw new Error("Update history disappeared before reconciliation");
  }
  return result;
}

/** Select without write access, then reread eligibility under the existing-schema writer. */
export async function reconcileAbandonedUpdateRunsAsync(
  input: UpdateRunReconciliationInput = {},
  options: ReconciliationOptions = {},
): Promise<UpdateRunRecord[]> {
  if (input.runIds?.length === 0) {
    return [];
  }
  const selection = { ...input, ...(input.runIds ? { runIds: [...input.runIds] } : {}) };
  const prepared = prepareReconciliation(options);
  const reply = await prepared.read({
    type: "updateRuns.reconciliationCandidates",
    input: selection,
  });
  if (!reply) {
    return [];
  }
  return (await reconcileCandidates(reply.candidates, selection, prepared)).reconciled;
}

/** History remains readable when best-effort reconciliation cannot obtain write access. */
export async function getUpdateRunWithReconciliationAsync(
  runId: string,
  options: ReconciliationOptions = {},
): Promise<{ run: UpdateRunRecord | undefined; reconciliationError?: string }> {
  const prepared = prepareReconciliation(options);
  const reply = await prepared.read({ type: "updateRuns.reconciliationCandidate", runId });
  if (!reply) {
    return { run: undefined };
  }
  if (!reply.candidate) {
    return { run: undefined };
  }
  try {
    return { run: (await reconcileCandidates([reply.candidate], {}, prepared)).current[0] };
  } catch (error) {
    prepared.assertCurrent();
    return { run: reply.candidate.record, reconciliationError: formatErrorMessage(error) };
  }
}
