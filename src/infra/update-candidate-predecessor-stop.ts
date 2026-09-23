import { needsCandidateManagedServiceStop } from "../cli/update-cli/update-command-legacy-service-stop.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-context-types.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "./gateway-shutdown-budget.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import type { UpdateRunResult } from "./update-runner-types.js";

/** Ledger step the delegated Doctor records at the native stop boundary. */
const CANDIDATE_PREDECESSOR_STOP_STEP = "managed-service:candidate-stop";

/** Identity of the service the Doctor stopped; finalization adopts only a matching service. */
type StoppedServiceIdentity = {
  pid?: number;
  fingerprint?: string;
  managerUid?: number;
  stoppedAtMs: number;
};

function serviceIdentity(
  state: PreManagedServiceStop,
  stoppedAtMs: number,
): StoppedServiceIdentity {
  const verdict = state.serviceUpdateVerdict;
  return {
    ...(state.servicePid !== undefined ? { pid: state.servicePid } : {}),
    ...(verdict && "fingerprint" in verdict ? { fingerprint: verdict.fingerprint } : {}),
    ...(state.serviceManagerUid !== undefined ? { managerUid: state.serviceManagerUid } : {}),
    stoppedAtMs,
  };
}

function readDoctorStop(runId: string, ledger: UpdateRunLedgerOptions) {
  const step = getUpdateRun(runId, ledger)?.steps?.find(
    (entry) => entry.step === CANDIDATE_PREDECESSOR_STOP_STEP && entry.status === "completed",
  );
  if (!step?.detail) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(step.detail);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>; // SAFETY: narrowed to a non-null object above
  const optionalNumber = (value: unknown) => (typeof value === "number" ? value : undefined);
  const stoppedAtMs = optionalNumber(record.stoppedAtMs);
  if (stoppedAtMs === undefined) {
    return undefined;
  }
  const identity: StoppedServiceIdentity = { stoppedAtMs };
  const pid = optionalNumber(record.pid);
  const managerUid = optionalNumber(record.managerUid);
  if (pid !== undefined) {
    identity.pid = pid;
  }
  if (managerUid !== undefined) {
    identity.managerUid = managerUid;
  }
  if (typeof record.fingerprint === "string") {
    identity.fingerprint = record.fingerprint;
  }
  return identity;
}

/**
 * A legacy updater (through 2026.9.5) that could not inspect the managed
 * service leaves the predecessor Gateway running and then delegates Doctor to
 * this candidate. That supervised owner keeps gateway-lifecycle until its
 * service manager stops it, so Doctor can never enter maintenance. Stop it
 * here with this candidate's adapter and record the stopped service's identity
 * at the mutation boundary; finalization restarts the updated service.
 */
export async function stopSupervisedPredecessorGateway(
  input: { runId: string; repair: boolean },
  params: {
    root: string;
    timeoutMs?: number;
    assertCurrent: () => void;
    warn: (message: string) => void;
  },
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
  let recorded = false;
  const record = (state: PreManagedServiceStop) => {
    if (recorded) {
      return;
    }
    recorded = true;
    const stoppedAtMs = state.stoppedAtMs ?? Date.now();
    recordUpdateRunStep(input.runId, {
      step: CANDIDATE_PREDECESSOR_STOP_STEP,
      status: "completed",
      endedAtMs: stoppedAtMs,
      detail: JSON.stringify(serviceIdentity(state, stoppedAtMs)),
    });
  };
  // The native stop reports its mutation before later checks can still throw;
  // the ledger keeps that fact for finalization and recovery either way.
  try {
    const state = await maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "package",
      root: params.root,
      shouldRestart: true,
      jsonMode: true,
      phase: "prepare",
      // The delegated Doctor input carries no step budget; bound the drain and
      // stop by the service stop budget so a stuck predecessor cannot outlive
      // the parent's Doctor allowance.
      timeoutMs: params.timeoutMs ?? GATEWAY_SERVICE_STOP_TIMEOUT_MS,
      onStopped: record,
      assertCurrent: params.assertCurrent,
      warn: params.warn,
    });
    if (state.stopped) {
      record(state);
    }
  } catch (error) {
    if (!recorded) {
      throw error;
    }
    // The stop already happened; Doctor decides whether the lock is free now.
    params.warn(
      `Predecessor Gateway stop reported an error after its native mutation: ${String(error)}`,
    );
  }
  return recorded;
}

/**
 * Finalization from a legacy parent: adopt the candidate's own service
 * inspection when the parent transferred an uninspected service, so the
 * existing restart path can start the updated service after Doctor. A stop the
 * delegated Doctor performed is adopted only for the same service identity, and
 * a Gateway the candidate itself stopped is never left down under --no-restart.
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
}): Promise<{ stopped: PreManagedServiceStop | undefined; restartRequired: boolean }> {
  const unchanged = { stopped: params.transferred, restartRequired: false };
  if (process.platform === "win32") {
    return unchanged;
  }
  const doctorStop = readDoctorStop(params.runId, params.ledger);
  if (
    !needsCandidateManagedServiceStop({
      ...params,
      preManagedServiceStop: params.transferred,
      shouldRestart: params.shouldRestart || doctorStop !== undefined,
    })
  ) {
    return unchanged;
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
    return { stopped, restartRequired: false };
  }
  let restartRequired = false;
  if (!stopped.stopped && doctorStop && !stopped.running) {
    const current = serviceIdentity(stopped, doctorStop.stoppedAtMs);
    const sameService =
      current.fingerprint === doctorStop.fingerprint &&
      current.managerUid === doctorStop.managerUid;
    if (sameService) {
      stopped = { ...stopped, stopped: true, stoppedAtMs: doctorStop.stoppedAtMs };
      // The candidate stopped this Gateway for Doctor; restart is restoration, not a bounce.
      restartRequired = !params.shouldRestart;
    }
  }
  if (stopped.stopped) {
    params.onStep({
      name: "managed-service",
      command: "stop managed gateway service before Doctor (candidate inspection)",
      cwd: params.root,
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      ...(restartRequired
        ? {
            advisory: {
              kind: "recoverable-maintenance",
              message:
                "The previous Gateway had to be stopped for update Doctor maintenance; it is restarted on the updated installation despite --no-restart.",
            },
          }
        : {}),
    });
  }
  return { stopped, restartRequired };
}
