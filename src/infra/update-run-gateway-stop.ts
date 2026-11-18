import type { UpdateRunRecord } from "./update-run-record.js";

export function hasUpdateGatewayStopIntent(run: UpdateRunRecord): boolean {
  // Terminal bookkeeping marks an unacknowledged stop failed; it remains intent.
  const stopped = run.steps.some(
    ({ step, status }) =>
      step === "service-stop" &&
      (status === "completed" || status === "in_progress" || status === "failed"),
  );
  // Target selection can replace "managed-service" with "npm-global". Both
  // Gateway update entry points also persist this handoff before activation.
  const managed =
    run.target.installationMethod === "managed-service" ||
    run.steps.some(
      ({ step, status }) => step === "managed-service update handoff" && status === "completed",
    );
  return (
    stopped ||
    (managed && (run.phase === "activating" || run.steps.some(({ step }) => step === "activating")))
  );
}

/** Newest-first history: a later start retires an update's unfulfilled stop intent. */
export function findUpdateGatewayStop(
  runs: readonly UpdateRunRecord[],
): { runId: string; started: boolean } | undefined {
  let started = false;
  for (const run of runs) {
    if (run.verification.settled === true) {
      return undefined;
    }
    const stopped = hasUpdateGatewayStopIntent(run);
    // update.run snapshots its original Gateway before handoff. That bare
    // running flag survives activation; replacement boots have their own receipt.
    started ||=
      (run.verification.serviceRunning === true &&
        (!stopped || run.verification.booted === true)) ||
      run.steps.some(
        ({ step, status }) =>
          ["service-start", "service-running", "managed-service-restart"].includes(step) &&
          status === "completed",
      );
    if (stopped) {
      return { runId: run.runId, started };
    }
  }
  return undefined;
}
