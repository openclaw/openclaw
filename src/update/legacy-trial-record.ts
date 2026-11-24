import { z } from "zod";
import { recordedUpdateRunDrivers } from "../infra/update-run-activity.js";
import { inspectUpdateRunDriver } from "../infra/update-run-driver.js";
import { isUpdateRepairRun, type UpdateRunRecord } from "../infra/update-run-record.js";
import { safeParseJsonWithSchema } from "../utils/zod-parse.js";

export const LEGACY_TRIAL_PREPARED = "finalize:legacy-release-prepared";
export const LEGACY_TRIAL_READY = "finalize:legacy-release-ready";

// #204145: main-tracking installs wrote this format before the resident launcher.
// Do not accept modern trials, deferred selection, or an unfinished rollback.
export const legacyTrialSchema = z.object({
  v: z.undefined().optional(),
  runId: z.undefined().optional(),
  phase: z.undefined().optional(),
  outcome: z.undefined().optional(),
  target: z.string().min(1),
  previous: z.string().min(1),
  version: z.string().min(1),
  buildId: z.string().min(1).max(96),
  createdAt: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  pending: z.literal(false).optional(),
  restoring: z.undefined().optional(),
});

// Existing history steps carry the admitted run's correlation, not a new trial protocol.
const legacyTrialReceiptSchema = legacyTrialSchema.pick({
  target: true,
  previous: true,
  version: true,
  buildId: true,
  createdAt: true,
});
export type LegacyTrialReceipt = z.infer<typeof legacyTrialReceiptSchema>;

export function projectLegacyTrialReceipt({
  target,
  previous,
  version,
  buildId,
  createdAt,
}: LegacyTrialReceipt): LegacyTrialReceipt {
  return { target, previous, version, buildId, createdAt };
}

export function readLegacyTrialReceipt(run: UpdateRunRecord, ready = false) {
  const detail = run.steps.find(
    (step) =>
      step.step === (ready ? LEGACY_TRIAL_READY : LEGACY_TRIAL_PREPARED) &&
      step.status === "completed",
  )?.detail;
  return detail ? safeParseJsonWithSchema(legacyTrialReceiptSchema, detail) : undefined;
}

export function sameLegacyTrial(left: LegacyTrialReceipt, right: LegacyTrialReceipt): boolean {
  return (
    left.target === right.target &&
    left.previous === right.previous &&
    left.version === right.version &&
    left.buildId === right.buildId &&
    left.createdAt === right.createdAt
  );
}

/** Retain eligible prepared trials; completion also requires the matching ready receipt. */
export function recoverableLegacyTrial(
  run: UpdateRunRecord,
  requireReady = true,
): LegacyTrialReceipt | undefined {
  const prepared = readLegacyTrialReceipt(run);
  const ready = readLegacyTrialReceipt(run, true);
  const abandoned = run.status === "failed" && run.reason === "abandoned";
  const drivers = recordedUpdateRunDrivers(run);
  if (
    !prepared ||
    (requireReady && !ready) ||
    (ready && !sameLegacyTrial(prepared, ready)) ||
    run.target.kind !== "git" ||
    run.repair.length ||
    run.verification.recovery ||
    run.verification.rollbackOutcome ||
    !(
      abandoned ||
      (run.status === "running" &&
        !run.reason &&
        ["activating", "restarting", "verifying"].includes(run.phase))
    ) ||
    !drivers.length ||
    drivers.some((driver) => inspectUpdateRunDriver(driver) !== "dead") ||
    run.steps.some(
      (step) =>
        step.step === "driver:identity-unavailable" ||
        step.step === "package rollback" ||
        step.step === "previous generation restoration" ||
        (step.status === "failed" &&
          !(
            abandoned &&
            (step.step === "reconcile:abandoned" ||
              (["activating", "restarting", "verifying"].includes(step.step) &&
                !step.detail &&
                !step.failureFacts?.length))
          )),
    )
  ) {
    return undefined;
  }
  return prepared;
}

export function verifiedLegacyTrialRepair(
  run: UpdateRunRecord,
  repair: UpdateRunRecord | undefined,
  verification: UpdateRunRecord["verification"] | undefined,
) {
  if (
    !repair ||
    repair.runId === run.runId ||
    repair.status !== "running" ||
    !isUpdateRepairRun(repair) ||
    repair.steps.some((step) => step.status === "failed") ||
    !["doctor", "plugins", "targetConfigConvergence"].every((phase) =>
      repair.steps.some((step) => step.step === `finalize:${phase}` && step.status === "completed"),
    )
  ) {
    return undefined;
  }
  return verifiedLegacyTrialReadiness(run, verification);
}

export function verifiedLegacyTrialReadiness(
  run: UpdateRunRecord,
  verification: UpdateRunRecord["verification"] | undefined,
) {
  const candidate = recoverableLegacyTrial(run);
  if (
    !candidate ||
    verification?.runningBuildId !== candidate.buildId ||
    verification.runningVersion !== candidate.version ||
    verification.booted !== true ||
    verification.serviceRunning !== true ||
    verification.versionMatch !== true ||
    verification.settled !== true ||
    (verification.coreReady ?? verification.readyz) !== true
  ) {
    return undefined;
  }
  return candidate;
}
