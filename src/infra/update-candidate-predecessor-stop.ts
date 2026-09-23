import { needsCandidateManagedServiceStop } from "../cli/update-cli/update-command-legacy-service-stop.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-context-types.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import type { UpdateRunResult } from "./update-runner-types.js";

/** Ledger step the delegated Doctor records after it stopped the predecessor Gateway. */
export const CANDIDATE_PREDECESSOR_STOP_STEP = "managed-service:candidate-stop";

type StopParams = {
  root: string;
  timeoutMs?: number;
  assertCurrent: () => void;
  warn: (message: string) => void;
};

/**
 * A legacy updater (through 2026.9.5) that could not inspect the managed
 * service leaves the predecessor Gateway running and then delegates Doctor to
 * this candidate. That supervised owner keeps gateway-lifecycle until its
 * service manager stops it, so Doctor can never enter maintenance. Stop it
 * here with this candidate's adapter; finalization restarts the updated service.
 */
export async function stopSupervisedPredecessorGateway(
  input: { runId: string; repair: boolean },
  params: StopParams,
): Promise<boolean> {
  if (!input.repair || process.platform === "win32") {
    return false;
  }
  let owner: ReturnType<typeof readGatewayOwnerLease>;
  try {
    owner = readGatewayOwnerLease({
      env: process.env,
      current: true,
      openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
    });
  } catch {
    return false;
  }
  if (owner?.state !== "live" || owner.mode !== "supervised") {
    return false;
  }
  params.assertCurrent();
  const state = await maybeStopManagedServiceBeforeMutableUpdate({
    updateInstallKind: "package",
    root: params.root,
    shouldRestart: true,
    jsonMode: true,
    phase: "prepare",
    timeoutMs: params.timeoutMs,
    assertCurrent: params.assertCurrent,
    warn: params.warn,
  });
  if (!state.stopped) {
    return false;
  }
  recordUpdateRunStep(input.runId, {
    step: CANDIDATE_PREDECESSOR_STOP_STEP,
    status: "completed",
    endedAtMs: state.stoppedAtMs ?? Date.now(),
    detail: `Stopped the predecessor Gateway service (pid ${state.servicePid ?? "unknown"}) before update Doctor.`,
  });
  return true;
}

/**
 * Finalization from a legacy parent: adopt the candidate's own service
 * inspection when the parent transferred an uninspected service, so the
 * existing restart path can start the updated service after Doctor.
 */
export async function adoptCandidateManagedServiceStop(params: {
  transferred: PreManagedServiceStop | undefined;
  shouldRestart: boolean;
  mode: UpdateRunResult["mode"];
  windowsTaskAutoStartSuspended?: boolean;
  runId: string;
  ledger: UpdateRunLedgerOptions;
  root: string;
  timeoutMs?: number;
  assertCurrent: () => void;
  onStep: (step: UpdateRunResult["steps"][number]) => void;
}): Promise<PreManagedServiceStop | undefined> {
  if (
    process.platform === "win32" ||
    !needsCandidateManagedServiceStop({ ...params, preManagedServiceStop: params.transferred })
  ) {
    return params.transferred;
  }
  const startedAt = Date.now();
  let stopped = params.transferred;
  const state = await maybeStopManagedServiceBeforeMutableUpdate({
    updateInstallKind: params.mode === "git" ? "git" : "package",
    root: params.root,
    shouldRestart: true,
    jsonMode: true,
    timeoutMs: params.timeoutMs,
    phase: "prepare",
    onStopped: (current) => {
      stopped = current;
    },
    assertCurrent: params.assertCurrent,
  });
  if (state.inspected || state.stopped) {
    stopped = state;
  }
  if (!stopped?.inspected) {
    return stopped;
  }
  // The delegated Doctor already stopped it under this run; keep that fact.
  const doctorStop = getUpdateRun(params.runId, params.ledger)?.steps.find(
    (step) => step.step === CANDIDATE_PREDECESSOR_STOP_STEP && step.status === "completed",
  );
  if (!stopped.stopped && doctorStop && !stopped.running) {
    stopped = { ...stopped, stopped: true, stoppedAtMs: doctorStop.endedAtMs ?? startedAt };
  }
  if (stopped.stopped) {
    params.onStep({
      name: "managed-service",
      command: "stop managed gateway service before Doctor (candidate inspection)",
      cwd: params.root,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
    });
  }
  return stopped;
}
