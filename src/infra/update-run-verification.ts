import { hasUpdateGatewayStopIntent } from "./update-run-gateway-stop.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { upsertStep } from "./update-run-step-upsert.js";

export function isUpdateRunVerificationConfirmed(
  verification: UpdateRunRecord["verification"],
): boolean {
  return (
    verification.serviceRunning === true &&
    verification.versionMatch === true &&
    verification.settled === true &&
    (verification.coreReady ??
      (verification.readyz === true && verification.channelsReady === true)) &&
    verification.pluginErrors?.length === 0
  );
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
  // Preserve post-stop liveness independently of readiness and a later operator
  // stop. Pre-handoff snapshots and patches without a running observation do not count.
  if (verification.serviceRunning === true && hasUpdateGatewayStopIntent(record)) {
    upsertStep(record, {
      step: "service-running",
      status: "completed",
      endedAtMs: Date.now(),
    });
  }
  // A skipped observer cannot revoke the durable receipt of a delivered notice.
  let observedVerification = verification;
  if (record.verification.noticeDelivered === true && verification.noticeDelivered === false) {
    observedVerification = { ...verification };
    delete observedVerification.noticeDelivered;
  }
  record.verification = {
    ...record.verification,
    // A released observer's readiness verdict cannot inherit a newer core proof.
    ...(verification.readyz !== undefined && verification.coreReady === undefined
      ? { coreReady: undefined }
      : {}),
    ...observedVerification,
    ...(verification.pluginErrors ? { pluginErrors: verification.pluginErrors.slice(-32) } : {}),
  };
  if (record.status === "running" && verification.serviceRunning === false) {
    record.confirmedAtMs = null;
  }
  if (isUpdateRunVerificationConfirmed(record.verification) && record.confirmedAtMs === null) {
    record.confirmedAtMs = Date.now();
  }
}
