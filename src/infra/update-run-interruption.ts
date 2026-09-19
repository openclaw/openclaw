import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  inspectUpdateRepairDriverAdmission,
  recordedUpdateRunDrivers,
} from "./update-run-activity.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { inspectUpdateRunDriver } from "./update-run-driver.js";
import {
  readActiveUpdateRun,
  readLatestUpdateRun,
  readUpdateRunRecord,
} from "./update-run-reader.js";
import { finishUpdateRunRecord, type UpdateRunRecord } from "./update-run-record.js";
import { hasStoredUpdateRecovery } from "./update-run-recovery-store.js";
import { recordUpdateRunVerificationRecord } from "./update-run-verification.js";
import { persistRun, updateRunLedgerSchema, upsertStep } from "./update-run-write.js";

const CANDIDATE_STEP = "finalize:installed-candidate";
const candidateSchema = z.object({
  version: z.string().trim().min(1).max(1024),
  buildId: z.string().trim().min(1).max(96),
});
export type InstalledUpdateCandidate = z.infer<typeof candidateSchema>;

export function readInstalledUpdateCandidate(
  run: UpdateRunRecord,
): InstalledUpdateCandidate | undefined {
  const receipt = run.steps.find(
    (step) => step.step === CANDIDATE_STEP && step.status === "completed",
  );
  if (!receipt?.detail) {
    return undefined;
  }
  try {
    const parsed = candidateSchema.safeParse(JSON.parse(receipt.detail));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Shipped parents can terminate the post-core child as soon as its result appears. */
export function recordPostCoreUpdateEvidence(
  runId: string,
  input: { candidate?: { version: string | null; buildId?: string }; warnings: string[] },
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

function canSettleInterruptedUpdate(run: UpdateRunRecord): boolean {
  const abandoned = run.status === "failed" && run.reason === "abandoned";
  if (!(run.status === "running" && run.phase === "verifying" && !run.reason) && !abandoned) {
    return false;
  }
  const drivers = recordedUpdateRunDrivers(run);
  return (
    drivers.length > 0 &&
    drivers.every((driver) => inspectUpdateRunDriver(driver) === "dead") &&
    run.repair.length === 0 &&
    run.steps.some(
      (step) => step.step === "post-update verification" && step.status === "completed",
    ) &&
    run.steps.some((step) => step.step === "restarting" && step.status === "completed") &&
    !run.steps.some(
      (step) =>
        step.step === "driver:identity-unavailable" ||
        step.step === "reconcile:acknowledged" ||
        step.step === "package rollback" ||
        step.step === "previous generation restoration" ||
        (step.status === "failed" &&
          !(
            abandoned &&
            (step.step === "reconcile:abandoned" ||
              (step.step === "verifying" && !step.detail && !step.failureFacts?.length))
          )),
    ) &&
    readInstalledUpdateCandidate(run) !== undefined
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
  const expected = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    const run = readLatestUpdateRun(db);
    return run && !hasStoredUpdateRecovery(db, run.runId) ? run : undefined;
  }, options);
  const candidate = expected ? readInstalledUpdateCandidate(expected) : undefined;
  if (!expected || !candidate || !canSettleInterruptedUpdate(expected)) {
    return [];
  }
  const { observeInterruptedUpdateGateway } = await import("./update-run-interruption-health.js");
  const observation = await observeInterruptedUpdateGateway(candidate, {
    ...input,
    env,
  });
  input.signal?.throwIfAborted();
  if (!observation) {
    return [];
  }
  const { verification, settleBudgetExceeded } = observation;
  // When the settle budget expires without a healthy serving match, record the
  // outcome so it is visible in the run history and warn operators. The run
  // remains eligible for a future reconciliation attempt — a subsequent update
  // or service restart may produce a healthy Gateway. Silent expiry is the
  // failure class this repo treats as the worst.
  if (!verification && settleBudgetExceeded) {
    runExistingOpenClawStateWriteTransaction(
      ({ db }) => {
        input.signal?.throwIfAborted();
        const current = readLatestUpdateRun(db);
        if (
          !current ||
          !isDeepStrictEqual(current, expected) ||
          !canSettleInterruptedUpdate(current)
        ) {
          return;
        }
        // Record the outcome only on the first expiry; subsequent retries
        // must not advance updatedAtMs or endedAtMs, because those timestamps
        // feed the abandonment inactivity window. Renewing them on every
        // failed probe would keep a dead updater alive indefinitely.
        if (current.steps.some((step) => step.step === "reconcile:settle-budget-exceeded")) {
          return;
        }
        upsertStep(current, {
          step: "reconcile:settle-budget-exceeded",
          status: "completed",
          endedAtMs: Date.now(),
          detail: "Settle budget expired without a healthy serving match; will retry.",
        });
        persistRun(db, current, options);
      },
      options,
      { schemaSql: updateRunLedgerSchema, operationLabel: "update.run" },
    );
    console.warn(
      "[openclaw] Interrupted update settle probe expired without a healthy gateway; the update remains pending and will be retried.",
    );
    return [];
  }
  if (!verification) {
    return [];
  }
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      input.signal?.throwIfAborted();
      const current = readLatestUpdateRun(db);
      const active = readActiveUpdateRun(db);
      if (
        !current ||
        !isDeepStrictEqual(current, expected) ||
        !canSettleInterruptedUpdate(current) ||
        (active && active.runId !== current.runId) ||
        hasStoredUpdateRecovery(db, current.runId)
      ) {
        return [];
      }
      if (current.status === "failed") {
        current.status = "running";
        current.phase = "verifying";
        current.finishedAtMs = null;
        for (const step of current.steps) {
          if (step.step === "reconcile:abandoned") {
            step.status = "completed";
          }
        }
      }
      recordUpdateRunVerificationRecord(current, verification);
      upsertStep(current, {
        step: "warning:finalize:interrupted-completion",
        status: "completed",
        endedAtMs: Date.now(),
        detail: `Updater exited before recording completion; installed and serving candidate build ${candidate.buildId} verified.`,
      });
      finishUpdateRunRecord(current, { status: "succeeded", after: candidate });
      return [persistRun(db, current, options)];
    },
    options,
    { schemaSql: updateRunLedgerSchema, operationLabel: "update.run" },
  );
}
