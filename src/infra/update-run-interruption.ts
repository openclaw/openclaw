import {
  createGatewayRestartDeadline,
  GatewayRestartDeadlineError,
} from "../cli/daemon-cli/restart-health-deadline.js";
import { INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { inspectUpdateRepairDriverAdmission } from "./update-run-activity.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { InterruptedUpdateGatewayObservation } from "./update-run-interruption-health.js";
import {
  canSettleInterruptedUpdate,
  installedUpdateCandidateSchema as candidateSchema,
  readInstalledUpdateCandidate,
} from "./update-run-interruption-store.js";
import {
  readInterruptedUpdateCandidateAsync,
  persistInterruptedUpdateObservationAsync,
} from "./update-run-interruption-worker.js";
import { hasStoredUpdateRecovery, readUpdateRunRecord } from "./update-run-read.kernel.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { persistRun, updateRunLedgerSchema, upsertStep } from "./update-run-write.js";
import type { UpdateStepResult } from "./update-step-result.js";
export { readInstalledUpdateCandidate } from "./update-run-interruption-store.js";

const CANDIDATE_STEP = "finalize:installed-candidate";

/** Shipped parents can terminate the post-core child as soon as its result appears. */
export function recordPostCoreUpdateEvidence(
  runId: string,
  input: {
    candidate?: { version: string | null; buildId?: string };
    warnings: string[];
    doctorLint?: UpdateStepResult;
  },
  options: UpdateRunLedgerOptions = {},
): void {
  runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const run = readUpdateRunRecord(db, runId);
      if (
        !run ||
        run.status !== "running" ||
        inspectUpdateRepairDriverAdmission([run], runId).kind !== "continuation"
      ) {
        throw new Error("Cannot verify a live parent for the inherited update history.");
      }
      const candidate = candidateSchema.safeParse(input.candidate);
      for (const step of input.doctorLint ? updateRunStepsFromResultStep(input.doctorLint) : []) {
        upsertStep(run, step);
      }
      if (candidate.success && !hasStoredUpdateRecovery(db, runId)) {
        // Keep after.version empty until serving verification: released rollback
        // readers use that absence to recognize restored-generation observations.
        upsertStep(run, {
          step: CANDIDATE_STEP,
          status: "completed",
          endedAtMs: Date.now(),
          detail: JSON.stringify(candidate.data),
        });
      }
      for (const [index, detail] of input.warnings.entries()) {
        upsertStep(run, {
          step: `warning:finalize:plugins:${index}`,
          status: "completed",
          endedAtMs: Date.now(),
          detail,
        });
      }
      persistRun(db, run, options);
    },
    options,
    { schemaSql: updateRunLedgerSchema, operationLabel: "update.run" },
  );
}

/** Correct only a proven interrupted completion; all other terminal outcomes remain immutable. */
export async function reconcileInterruptedUpdateRuns(
  input: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<UpdateRunRecord[]> {
  const env = { ...(input.env ?? process.env) };
  const options = { env, path: resolveOpenClawStateSqlitePath(env) };
  // A later invocation may have installed the same build. Never attribute its
  // serving result to an older occurrence merely because the versions agree.
  const expected = await readInterruptedUpdateCandidateAsync(options);
  const candidate = expected ? readInstalledUpdateCandidate(expected) : undefined;
  if (!expected || !candidate || !canSettleInterruptedUpdate(expected)) {
    return [];
  }
  const managed = expected.steps.some(
    (step) => step.step === "restarting" && step.status === "completed",
  );
  let observation: InterruptedUpdateGatewayObservation = {
    outcome: "skipped-unmanaged",
    elapsedMs: 0,
    phase: "ownership",
  };
  let cleanup: Promise<"confirmed" | "unknown"> | undefined;
  if (managed) {
    const deadline = createGatewayRestartDeadline({
      timeoutMs: INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS,
      signal: input.signal,
    });
    try {
      observation = await deadline.run(async () => {
        const { observeInterruptedUpdateGateway } = await deadline.read(
          "setup:health-module",
          () => import("./update-run-interruption-health.js"),
        );
        return await observeInterruptedUpdateGateway(candidate, { ...input, env, deadline });
      });
    } catch (error) {
      input.signal?.throwIfAborted();
      observation = {
        outcome: hasCommandProcessCleanupError(error)
          ? "cleanup-unknown"
          : error instanceof GatewayRestartDeadlineError
            ? "timed-out"
            : "unverified",
        elapsedMs: Math.round(deadline.elapsedMs()),
        phase: deadline.expiredPhase ?? deadline.phase,
      };
    } finally {
      cleanup = deadline.cleanup;
      observation.cleanup = deadline.cleanupStatus;
      observation.timeout = deadline.timeout;
      deadline.dispose();
    }
  }
  input.signal?.throwIfAborted();
  const context = captureOpenClawStateWorkerContext(options);
  const record = async (
    captured: UpdateRunRecord,
    observed: InterruptedUpdateGatewayObservation,
  ) => {
    const detail =
      `Interrupted update settle probe: ${observed.outcome} after ${observed.elapsedMs} ms during ${observed.phase}.` +
      (observed.waitOutcome ? ` Health wait: ${observed.waitOutcome}.` : "") +
      (observed.timeout
        ? ` Deadline timed-out after ${observed.timeout.elapsedMs} ms during ${observed.timeout.phase}.`
        : "") +
      (observed.cleanup === "unknown"
        ? " Command cleanup failed: could not confirm that owned work stopped; cleanup outcome unknown. Check openclaw update status before recovery."
        : observed.cleanup === "pending"
          ? " Command cleanup is still pending; cleanup outcome unknown. Completion is not verified."
          : observed.verification
            ? " Installed and serving candidate verified."
            : managed
              ? " Continuing without verified completion; will retry. Check openclaw update status."
              : " No completed managed-service restart was recorded; probing skipped.");
    const result = await persistInterruptedUpdateObservationAsync(
      context,
      {
        expected: captured,
        detail,
        verification: observed.verification,
        cleanup: observed.cleanup,
      },
      input.signal,
    );
    if (result?.accepted || observed.cleanup === "unknown") {
      console.warn(`[openclaw] ${detail}`);
    }
    return result;
  };
  const recorded = record(expected, observation);
  if (observation.cleanup === "pending" && cleanup) {
    // Preserve late custody facts without extending the operator-visible observation deadline.
    void cleanup
      .then(async (outcome) => {
        const initial = await recorded;
        if (!initial?.accepted || !initial.run) {
          return;
        }
        await record(initial.run, {
          ...observation,
          outcome: outcome === "unknown" ? "cleanup-unknown" : observation.outcome,
          cleanup: outcome,
          verification: undefined,
        });
      })
      .catch(() => {
        console.warn(
          "[openclaw] Command cleanup outcome unknown; interrupted update cleanup could not be recorded. Check openclaw update status before recovery.",
        );
      });
  }
  const result = await recorded;
  return result?.accepted && result.run && observation.verification ? [result.run] : [];
}
