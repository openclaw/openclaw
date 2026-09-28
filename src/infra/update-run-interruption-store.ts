import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { recordedUpdateRunDrivers } from "./update-run-activity.js";
import { encodeRun, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import { inspectUpdateRunDriver } from "./update-run-driver.js";
import type {
  InterruptedUpdateSettlement,
  InterruptedUpdateSettlementResult,
} from "./update-run-interruption-contract.js";
import {
  hasStoredUpdateRecovery,
  readActiveUpdateRun,
  readLatestUpdateRun,
  readUpdateRunRecord,
} from "./update-run-read.kernel.js";
import { finishUpdateRunRecord, type UpdateRunRecord } from "./update-run-record.js";
import { recordUpdateRunVerificationRecord } from "./update-run-verification.js";
import { persistRun, updateRunLedgerSchema, upsertStep } from "./update-run-write.js";

export const installedUpdateCandidateSchema = z.object({
  version: z.string().trim().min(1).max(1024),
  buildId: z.string().trim().min(1).max(96),
});
export type InstalledUpdateCandidate = z.infer<typeof installedUpdateCandidateSchema>;

export function readInstalledUpdateCandidate(
  run: UpdateRunRecord,
): InstalledUpdateCandidate | undefined {
  const receipt = run.steps.find(
    (step) => step.step === "finalize:installed-candidate" && step.status === "completed",
  );
  if (!receipt?.detail) {
    return undefined;
  }
  try {
    const parsed = installedUpdateCandidateSchema.safeParse(JSON.parse(receipt.detail));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function canSettleInterruptedUpdate(run: UpdateRunRecord): boolean {
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

/** Revalidate the captured run and recovery exclusion inside the worker's transaction. */
export function persistInterruptedUpdateObservation(
  input: InterruptedUpdateSettlement,
  options: UpdateRunLedgerOptions,
  assertCurrent: (stage: "transaction" | "commit") => void,
): InterruptedUpdateSettlementResult {
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent("transaction");
      const accept = (run: UpdateRunRecord | undefined): InterruptedUpdateSettlementResult => {
        assertCurrent("commit");
        return { accepted: true, run };
      };
      const current = readLatestUpdateRun(db);
      const active = readActiveUpdateRun(db);
      if (
        !current ||
        !isDeepStrictEqual(current, input.expected) ||
        (active && active.runId !== current.runId) ||
        hasStoredUpdateRecovery(db, current.runId)
      ) {
        return { accepted: false };
      }
      const previous = current.steps.find((step) => step.step === "reconcile:settle");
      const completingCleanup =
        previous?.status === "failed" &&
        (input.cleanup === "unknown" || input.cleanup === "confirmed");
      // Only this exact persisted observation may replace its own pending cleanup result.
      const eligible = completingCleanup
        ? { ...current, steps: current.steps.filter((step) => step !== previous) }
        : current;
      if (!canSettleInterruptedUpdate(eligible)) {
        return { accepted: false };
      }
      const uncertain = input.cleanup === "pending" || input.cleanup === "unknown";
      const verification = uncertain ? undefined : input.verification;
      if (!verification && previous && input.cleanup === undefined) {
        return { accepted: true, run: current };
      }
      upsertStep(current, {
        step: "reconcile:settle",
        status: uncertain ? "failed" : "completed",
        endedAtMs: previous?.endedAtMs ?? Date.now(),
        detail: input.detail,
      });
      if (!verification && previous) {
        // Cleanup publication is diagnostic, not updater activity or a new abandonment window.
        const row = encodeRun(current, options);
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
            .updateTable("update_runs")
            .set({ steps_json: row.steps_json })
            .where("run_id", "=", current.runId),
        );
        return accept(readUpdateRunRecord(db, current.runId));
      }
      if (!verification) {
        return accept(persistRun(db, current, options));
      }
      const candidate = readInstalledUpdateCandidate(current);
      if (!candidate) {
        return { accepted: false };
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
      return accept(persistRun(db, current, options));
    },
    options,
    { schemaSql: updateRunLedgerSchema, operationLabel: "update.run" },
  );
}
