import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunVerificationCheck = NonNullable<
  UpdateRunRecord["verification"]["checks"]
>[number];

const MAX_VERIFICATION_CHECKS = 32;

export function isUpdateRunNormalCycleAwaiting(
  run: UpdateRunRecord,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  return (
    run.status === "succeeded" &&
    run.phase === "finished" &&
    run.finishedAtMs !== null &&
    nowMs - run.finishedAtMs >= 0 &&
    nowMs - run.finishedAtMs <= maxAgeMs &&
    isUpdateRunVerificationConfirmed(run.verification) &&
    run.verification.normalCycle?.status !== "pass"
  );
}

export function isUpdateRunVerificationConfirmed(
  verification: UpdateRunRecord["verification"],
): boolean {
  return (
    verification.serviceRunning === true &&
    verification.versionMatch === true &&
    verification.settled === true &&
    verification.readyz === true &&
    verification.channelsReady === true &&
    verification.pluginErrors?.length === 0
  );
}

export function recordUpdateRunVerificationCheckRecord(
  record: UpdateRunRecord,
  check: UpdateRunVerificationCheck,
  options: { onlyIfRunning?: true } = {},
): void {
  if (options.onlyIfRunning && record.status !== "running") {
    return;
  }
  const checks = [
    ...(record.verification.checks ?? []).filter((entry) => entry.id !== check.id),
    check,
  ];
  const required = checks.filter((entry) => entry.required !== false);
  if (required.length > MAX_VERIFICATION_CHECKS) {
    throw new Error("Required update verification checks exceed the retained check limit");
  }
  const optionalSlots = MAX_VERIFICATION_CHECKS - required.length;
  const optional =
    optionalSlots > 0
      ? checks.filter((entry) => entry.required === false).slice(-optionalSlots)
      : [];
  record.verification.checks = [...required, ...optional];
}

export function recordUpdateRunVerificationRecord(
  record: UpdateRunRecord,
  verification: UpdateRunRecord["verification"],
  options: { onlyIfRunning?: true } = {},
): void {
  // Startup observations cannot revise a terminal result, including one
  // committed after the Gateway read the run but before this transaction.
  if (options.onlyIfRunning && record.status !== "running") {
    return;
  }
  record.verification = {
    ...record.verification,
    ...verification,
    ...(verification.pluginErrors ? { pluginErrors: verification.pluginErrors.slice(-32) } : {}),
  };
  if (record.status === "running" && verification.serviceRunning === false) {
    record.confirmedAtMs = null;
  }
  if (isUpdateRunVerificationConfirmed(record.verification) && record.confirmedAtMs === null) {
    record.confirmedAtMs = Date.now();
  }
}
