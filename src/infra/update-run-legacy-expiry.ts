import type { UpdateRunRecord } from "./update-run-record.js";

export const LEGACY_UPDATE_RUN_EXPIRED_REASON = "legacy-driver-expired";
const LEGACY_UPDATE_RUN_EXPIRY_MS = 24 * 60 * 60_000;
export const LEGACY_UPDATE_RUN_ADVISORY =
  "A 2026.9.2-era update never progressed past admission; treated as abandoned after 24 h; run `openclaw update` to retry.";

/** The approved legacy expiry applies only to an untouched, identityless admission. */
export function isExpiredLegacyUpdateRun(run: UpdateRunRecord): boolean {
  const initial = run.steps[0];
  return (
    run.status === "running" &&
    run.phase === "requested" &&
    run.finishedAtMs === null &&
    run.updatedAtMs === run.createdAtMs &&
    !run.origin.driver &&
    !run.origin.previousDrivers?.length &&
    run.steps.length === 1 &&
    initial?.step === "requested" &&
    initial.status === "in_progress" &&
    initial.startedAtMs === run.createdAtMs &&
    initial.endedAtMs === undefined &&
    Date.now() - run.createdAtMs > LEGACY_UPDATE_RUN_EXPIRY_MS
  );
}
