import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { registerSignalExitGate } from "../cli/signal-exit-barrier.js";
import { needsCandidateManagedServiceStop } from "../cli/update-cli/update-command-legacy-service-stop.js";
import { UpdateCommandRecoveryPendingError } from "../cli/update-cli/update-command-recovery-error.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-context-types.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  findServiceOwnershipRefusal,
  hasGatewayServiceStopUnsafeError,
} from "../daemon/service-inspection-error.js";
import { GatewayServiceAuthorityError } from "../daemon/service-update-authority.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { readGatewayOwnerLease } from "./gateway-owner-lease.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "./gateway-shutdown-budget.js";
import { createSqliteLifecycleAggregateError } from "./sqlite-lifecycle-errors.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { getUpdateRunAsync } from "./update-run-reader.js";
import { recordUpdateRunStepAsync } from "./update-run-write.async.js";
import type { UpdateRunResult } from "./update-runner-types.js";

/**
 * Ledger receipt the delegated Doctor records at the native stop boundary.
 * The `finalize:` prefix keeps it through count eviction in both this codec and
 * the published parents'; the identity lives in the key because those parents
 * strip `detail` from retained steps under the byte limit.
 */
const RECEIPT_PREFIX = "finalize:predecessor-stop:";

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

function encodeReceipt(identity: StoppedServiceIdentity): string {
  const field = (value: number | string | undefined) =>
    value === undefined ? "-" : String(value).replaceAll(":", "_");
  return `${RECEIPT_PREFIX}${identity.stoppedAtMs}:${field(identity.managerUid)}:${field(identity.pid)}:${field(identity.fingerprint)}`;
}

function decodeReceipt(step: string): StoppedServiceIdentity | undefined {
  if (!step.startsWith(RECEIPT_PREFIX)) {
    return undefined;
  }
  const [stoppedAt, managerUid, pid, fingerprint] = step.slice(RECEIPT_PREFIX.length).split(":");
  const stoppedAtMs = Number(stoppedAt);
  if (!Number.isFinite(stoppedAtMs)) {
    return undefined;
  }
  const number = (value: string | undefined) =>
    value === undefined || value === "-" || !/^\d+$/.test(value) ? undefined : Number(value);
  const identity: StoppedServiceIdentity = { stoppedAtMs };
  const parsedPid = number(pid);
  const parsedUid = number(managerUid);
  if (parsedPid !== undefined) {
    identity.pid = parsedPid;
  }
  if (parsedUid !== undefined) {
    identity.managerUid = parsedUid;
  }
  if (fingerprint && fingerprint !== "-") {
    identity.fingerprint = fingerprint;
  }
  return identity;
}

async function readDoctorStop(runId: string, ledger: UpdateRunLedgerOptions) {
  for (const step of (await getUpdateRunAsync(runId, ledger))?.steps ?? []) {
    if (step.status !== "completed") {
      continue;
    }
    const identity = decodeReceipt(step.step);
    if (identity) {
      return identity;
    }
  }
  return undefined;
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
  const runId = input.runId;
  const env = cloneEnvWithPlatformSemantics(process.env);
  const context = captureOpenClawStateWorkerContext({ env });
  let recorded = false;
  let receipt: Promise<void> | undefined;
  const record = (state: PreManagedServiceStop) => {
    if (receipt) {
      return;
    }
    const stoppedAtMs = state.stoppedAtMs ?? Date.now();
    const step = encodeReceipt(serviceIdentity(state, stoppedAtMs));
    receipt = recordUpdateRunStepAsync(
      runId,
      { step, status: "completed", endedAtMs: stoppedAtMs },
      {
        env,
        context,
        assertCurrent: params.assertCurrent,
        retainSettlement(completion) {
          const release = registerSignalExitGate(completion);
          void completion.then(release, release);
        },
      },
    ).then((result) => {
      if (
        result.runId !== runId ||
        result.status !== "running" ||
        !result.steps.some((stored) => stored.step === step && stored.status === "completed")
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "The predecessor Gateway stopped, but its update receipt was not recorded; recovery remains pending.",
        );
      }
      recorded = true;
    });
    // The native callback stays synchronous; join its receipt after native cleanup below.
    void receipt.catch(() => undefined);
  };
  let stopFailure: { error: unknown } | undefined;
  try {
    // The native stop reports its mutation before later checks can still throw;
    // the ledger keeps that fact for finalization and recovery either way.
    const state = await maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "package",
      root: params.root,
      shouldRestart: true,
      jsonMode: true,
      phase: "prepare",
      // The delegated Doctor input carries no step budget; bound the drain and
      // stop by the service stop budget so a stuck predecessor cannot outlive
      // the parent's Doctor allowance.
      timeoutMs: GATEWAY_SERVICE_STOP_TIMEOUT_MS,
      onStopped: record,
      assertCurrent: params.assertCurrent,
      warn: params.warn,
    });
    if (state.stopped) {
      record(state);
    }
  } catch (error) {
    stopFailure = { error };
  }
  try {
    await receipt;
  } catch (error) {
    if (stopFailure && stopFailure.error !== error) {
      throw createSqliteLifecycleAggregateError(
        [stopFailure.error, error],
        "Predecessor Gateway stop and receipt persistence failed.",
        stopFailure.error,
      );
    }
    throw error;
  }
  if (stopFailure) {
    if (!recorded || hasCommandProcessCleanupError(stopFailure.error)) {
      throw stopFailure.error;
    }
    // The joined stop already happened; Doctor decides whether the lock is free now.
    params.warn(
      `Predecessor Gateway stop reported an error after its native mutation: ${String(stopFailure.error)}`,
    );
  }
  return recorded;
}

/**
 * Finalization: adopt a stop the delegated Doctor recorded for this run, or
 * perform the candidate's own stop when a legacy parent transferred an
 * uninspected service. A recorded stop is adopted only after a mutation-free
 * inspection reports the same service identity, and a Gateway the candidate
 * itself stopped is never left down under --no-restart.
 */
export async function adoptCandidateManagedServiceStop(params: {
  transferred: PreManagedServiceStop | undefined;
  shouldRestart: boolean;
  mode: UpdateRunResult["mode"];
  status: UpdateRunResult["status"];
  windowsTaskAutoStartSuspended?: boolean;
  runId: string;
  ledger: UpdateRunLedgerOptions;
  root: string;
  timeoutMs?: number;
  assertCurrent: () => void;
  onStopped?: (stopped: PreManagedServiceStop) => void;
  onStep: (step: UpdateRunResult["steps"][number]) => void;
}): Promise<{ stopped: PreManagedServiceStop | undefined; restartRequired: boolean }> {
  const unchanged = { stopped: params.transferred, restartRequired: false };
  if (process.platform === "win32") {
    return unchanged;
  }
  const startedAt = Date.now();
  const stopStep = (advisory?: string): UpdateRunResult["steps"][number] => ({
    name: "managed-service",
    command: "stop managed gateway service before Doctor (candidate inspection)",
    cwd: params.root,
    durationMs: Date.now() - startedAt,
    exitCode: 0,
    ...(advisory ? { advisory: { kind: "recoverable-maintenance", message: advisory } } : {}),
  });
  const updateInstallKind = params.mode === "git" ? "git" : "package";
  params.assertCurrent();
  const doctorStop = await readDoctorStop(params.runId, params.ledger);
  params.assertCurrent();
  if (doctorStop) {
    // Inspect without mutating: a service replaced after Doctor must not inherit the stop.
    let inspected: PreManagedServiceStop;
    try {
      inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind,
        root: params.root,
        shouldRestart: true,
        jsonMode: true,
        timeoutMs: params.timeoutMs,
        phase: "inspect",
        assertCurrent: params.assertCurrent,
      });
    } catch (cause) {
      if (
        hasCommandProcessCleanupError(cause) ||
        hasGatewayServiceStopUnsafeError(cause) ||
        findServiceOwnershipRefusal(cause) ||
        collectNestedErrorCandidates(cause).some(
          (error) => error instanceof GatewayServiceAuthorityError,
        )
      ) {
        throw cause;
      }
      try {
        params.assertCurrent();
      } catch {
        throw cause;
      }
      throw new UpdateCommandRecoveryPendingError(
        "Inspection of the Gateway stopped by update Doctor failed; recovery remains pending. Run openclaw gateway status --deep before resuming service recovery.",
        { cause },
      );
    }
    params.assertCurrent();
    if (!inspected.inspected || !inspected.runtimeInspected) {
      throw new UpdateCommandRecoveryPendingError(
        "The Gateway stopped by update Doctor could not be inspected; recovery remains pending. Run openclaw gateway status --deep before resuming service recovery.",
      );
    }
    const current = serviceIdentity(inspected, doctorStop.stoppedAtMs);
    if (
      current.fingerprint !== doctorStop.fingerprint ||
      current.managerUid !== doctorStop.managerUid
    ) {
      params.onStep({
        ...stopStep(
          "The Gateway service was replaced after update Doctor stopped its predecessor; the recorded stop was not adopted and the current service was left untouched.",
        ),
        exitCode: 1,
      });
      return unchanged;
    }
    if (inspected.running) {
      // The same service was started again after Doctor; nothing to restore.
      return { stopped: inspected, restartRequired: false };
    }
    const restartRequired = !params.shouldRestart;
    params.onStep(
      stopStep(
        restartRequired
          ? "The previous Gateway had to be stopped for update Doctor maintenance; it is restarted on the updated installation despite --no-restart."
          : undefined,
      ),
    );
    return {
      stopped: { ...inspected, stopped: true, stoppedAtMs: doctorStop.stoppedAtMs },
      restartRequired,
    };
  }
  if (
    params.status !== "ok" ||
    !needsCandidateManagedServiceStop({ ...params, preManagedServiceStop: params.transferred })
  ) {
    return unchanged;
  }
  let stopped = params.transferred;
  let observedStop = false;
  const state = await maybeStopManagedServiceBeforeMutableUpdate({
    updateInstallKind,
    root: params.root,
    shouldRestart: true,
    jsonMode: true,
    timeoutMs: params.timeoutMs,
    phase: "prepare",
    onStopped: (current) => {
      stopped = current;
      observedStop = true;
      params.onStopped?.(current);
    },
    assertCurrent: params.assertCurrent,
  });
  if (state.inspected || state.stopped) {
    stopped = state;
  }
  if (stopped?.stopped) {
    if (!observedStop) {
      params.onStopped?.(stopped);
    }
    params.onStep(stopStep());
  }
  return { stopped, restartRequired: false };
}
