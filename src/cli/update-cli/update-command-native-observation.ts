import { platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveLaunchAgentGuiDomain } from "../../daemon/launchd-runtime.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayServiceState,
} from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import type {
  UpdateRecoveryNativeIdentity,
  UpdateRecoveryNativeObservation,
} from "../../infra/update-run-recovery-native.js";
import type { UpdateRecoveryRecord } from "../../infra/update-run-recovery.js";
import { gatewayServiceCommandUsesInterruptedPackageRoot } from "./update-command-package-replay.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { gatewayServiceCommandUsesRoot } from "./update-command-service-plan.js";

/** Observations are evidence only. The caller retains its native lock and live
 * executor through inspection and the Recovery owner's exact-revision write.
 */
type NativeObservationParams = {
  record: Pick<UpdateRecoveryRecord, "runId" | "source" | "from"> & Partial<UpdateRecoveryRecord>;
  env: NodeJS.ProcessEnv;
  definitionPaths: readonly string[];
  assertCurrent: () => void;
  timeoutMs?: number;
  quiescingFailedCandidate?: true;
  /** Only a live source/executor owner may reload a checkpoint-bound unit definition. */
  inspectOwnedUnit?: () => void;
};

class PendingNativeRuntimeObservation extends UpdateCommandRecoveryPendingError {}

function failedCandidateQuiescence(params: NativeObservationParams) {
  return (
    params.quiescingFailedCandidate === true &&
    Boolean(params.record.primaryFailure) &&
    Boolean(params.record.checkpoint) &&
    Boolean(params.record.nativeManager) &&
    params.record.effects?.some(
      (effect) =>
        effect.kind === "service-restart" &&
        effect.state === "intent" &&
        effect.runtime === "candidate",
    ) === true &&
    !params.record.terminal &&
    platform() === "linux"
  );
}

/** Retain only refusal evidence between retries, never facts that permit work. */
function createRestartContinuityCheck(record: NativeObservationParams["record"]) {
  const identity = record.nativeManager?.identity;
  let floor: number | undefined;
  const conflict = () =>
    new UpdateCommandRecoveryPendingError(
      "Original native-manager state cannot be verified. [restart-counter]",
    );
  return (state: GatewayServiceState) => {
    const runtime = state.runtime;
    const native = runtime?.systemd;
    const count = native?.nRestarts;
    if (count === undefined) {
      if (floor !== undefined && (runtime?.status === "stopped" || runtime?.status === "running")) {
        throw conflict();
      }
      return;
    }
    if (!Number.isInteger(count) || count < 0 || (floor !== undefined && count < floor)) {
      throw conflict();
    }
    if (
      identity?.platform === "linux" &&
      identity.scope === "user" &&
      native &&
      native.unit === identity.unitName &&
      native.managerUid === identity.uid
    ) {
      floor = Math.max(floor ?? count, count);
    }
  };
}

export async function readUpdateCommandNativeObservation(
  params: NativeObservationParams,
): Promise<UpdateRecoveryNativeObservation> {
  if (!failedCandidateQuiescence(params)) {
    return await readNativeObservationOnce(params);
  }
  // A failed native start can still be transitioning between auto-restart and
  // its terminal state. Re-read only; never dispatch, infer drainage, or reuse
  // partial facts. Each attempt and delay retains the original live assertion.
  const budget = Math.min(
    params.timeoutMs !== undefined && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : 30_000,
    30_000,
  );
  const deadline = performance.now() + budget;
  const assertRestartContinuity = createRestartContinuityCheck(params.record);
  let lastUncertainRead: unknown;
  const assertCurrent = () => {
    params.assertCurrent();
    if (performance.now() >= deadline) {
      throw new PendingNativeRuntimeObservation(
        "Original native-manager observation exceeded its settlement deadline.",
        { cause: lastUncertainRead },
      );
    }
  };
  const inspectOwnedUnit = params.inspectOwnedUnit;
  const observedParams = {
    ...params,
    assertCurrent,
    ...(inspectOwnedUnit
      ? {
          inspectOwnedUnit() {
            assertCurrent();
            inspectOwnedUnit();
            assertCurrent();
          },
        }
      : {}),
  };
  for (;;) {
    assertCurrent();
    try {
      const observed = await readNativeObservationOnce(
        observedParams,
        deadline,
        assertRestartContinuity,
      );
      assertCurrent();
      return observed;
    } catch (error) {
      params.assertCurrent();
      if (!(error instanceof PendingNativeRuntimeObservation) || performance.now() >= deadline) {
        throw error;
      }
      lastUncertainRead = error;
      await delay(Math.min(100, deadline - performance.now()));
      assertCurrent();
    }
  }
}

async function readNativeObservationOnce(
  params: NativeObservationParams,
  deadline?: number,
  assertRestartContinuity?: (state: GatewayServiceState) => void,
): Promise<UpdateRecoveryNativeObservation> {
  const remainingTimeout = () => {
    params.assertCurrent();
    return deadline === undefined ? params.timeoutMs : Math.max(1, deadline - performance.now());
  };
  const unavailable = (reason?: string) =>
    new UpdateCommandRecoveryPendingError(
      `Original native-manager state cannot be verified.${reason ? ` [${reason}]` : ""}`,
    );
  const source = params.record.source;
  if (!source || source.profile === undefined) {
    throw unavailable();
  }
  // A failed start may leave a positively inspected systemd auto-restart job.
  // This proves only non-quiescence, never readiness or a stopped service.
  // Linux loadState reports is-enabled policy. Loaded-only command/runtime
  // reads below prove unit loading even after journaled suppression disables it.
  const autoRestarting = (value: GatewayServiceState) =>
    failedCandidateQuiescence(params) &&
    value.runtime?.status === "unknown" &&
    value.runtime.state === "activating" &&
    value.runtime.subState === "auto-restart" &&
    (value.runtime.pid === undefined || value.runtime.pid === 0) &&
    typeof value.runtime.systemd?.nRestarts === "number" &&
    Number.isInteger(value.runtime.systemd.nRestarts) &&
    value.runtime.systemd.nRestarts >= 0;
  const nativeIdentity = params.record.nativeManager?.identity;
  if (params.inspectOwnedUnit && (!params.record.checkpoint || !nativeIdentity)) {
    throw unavailable();
  }
  if (
    params.inspectOwnedUnit &&
    (nativeIdentity?.runId !== params.record.runId ||
      nativeIdentity.stateDir !== source.stateDir ||
      nativeIdentity.configPath !== source.configPath ||
      nativeIdentity.profile !== source.profile ||
      resolveStateDir(params.env) !== source.stateDir ||
      resolveConfigPath(params.env) !== source.configPath ||
      (params.env.OPENCLAW_PROFILE?.trim() || null) !== source.profile ||
      (nativeIdentity.platform === "linux" &&
        nativeIdentity.unitName !== `${resolveSystemdServiceName(params.env)}.service`))
  ) {
    throw unavailable();
  }
  const loadForInspection =
    params.inspectOwnedUnit &&
    platform() === "linux" &&
    nativeIdentity?.platform === "linux" &&
    nativeIdentity.scope === "user"
      ? {
          managerUid: nativeIdentity.uid,
          assertCurrent: params.inspectOwnedUnit,
          assertReadCurrent: params.assertCurrent,
        }
      : undefined;
  params.assertCurrent();
  const service = resolveGatewayService();
  // One collector for every frame: authority, remaining budget, and refusal-only
  // counter continuity cannot diverge between first, final, and closing reads.
  const inspect = async () => {
    const state = await readGatewayServiceState(service, {
      env: params.env,
      requireEffective: true,
      requireLoadedCommand: true,
      validateEnvBeforeStatusRead: params.assertCurrent,
      ...(loadForInspection ? { loadForInspection } : {}),
      timeoutMs: remainingTimeout(),
    });
    params.assertCurrent();
    assertRestartContinuity?.(state);
    return state;
  };
  const state = await inspect();
  // Report only fixed predicate names, never native output, paths or environment values.
  if (!state.installed) {
    throw unavailable("installation");
  }
  if (!state.command?.sourcePath) {
    throw unavailable("command");
  }
  const failedStateChecks = [
    [state.loadState.status === "unknown", "load-state"],
    [
      !(["running", "stopped"].includes(state.runtime?.status ?? "") || autoRestarting(state)),
      "runtime-state",
    ],
    [resolveStateDir(state.env) !== source.stateDir, "state-directory"],
    [resolveConfigPath(state.env) !== source.configPath, "config-path"],
    [(state.env.OPENCLAW_PROFILE?.trim() || null) !== source.profile, "profile"],
    [
      !isDeepStrictEqual(
        [
          ...new Set([state.command.sourcePath, ...(state.command.definitionPaths ?? [])]),
        ].toSorted(),
        [...new Set(params.definitionPaths)].toSorted(),
      ),
      "definition-paths",
    ],
  ] as const;
  for (const [failed, reason] of failedStateChecks) {
    if (failed) {
      if (reason === "runtime-state") {
        throw new PendingNativeRuntimeObservation(unavailable(reason).message);
      }
      throw unavailable(reason);
    }
  }
  let belongsToRoot = await gatewayServiceCommandUsesRoot({
    root: params.record.from.root,
    env: state.env,
    command: state.command,
  });
  params.assertCurrent();
  if (belongsToRoot === null && state.runtime?.status === "stopped") {
    belongsToRoot = await gatewayServiceCommandUsesInterruptedPackageRoot({
      record: params.record,
      command: state.command,
    });
    params.assertCurrent();
  }
  if (!belongsToRoot || !service.isEnabled) {
    throw unavailable();
  }
  const enabled = await service.isEnabled({ env: state.env, timeoutMs: remainingTimeout() });
  params.assertCurrent();
  // Enable inspection awaits native work. Do not combine its result with an
  // earlier process/manager generation that changed in the meantime.
  const finalState = await inspect();
  const definitionFacts = (value: GatewayServiceState) => ({
    installed: value.installed,
    command: value.command,
    env: value.env,
    loadState: value.loadState.status,
  });
  const identityFacts = (value: GatewayServiceState) => ({
    ...definitionFacts(value),
    status: value.runtime?.status,
    pid: value.runtime?.pid,
    unit: value.runtime?.systemd?.unit,
    managerUid: value.runtime?.systemd?.managerUid,
    autoRestart: autoRestarting(value)
      ? {
          state: value.runtime?.state,
          subState: value.runtime?.subState,
          restarts: value.runtime?.systemd?.nRestarts,
        }
      : undefined,
  });
  const assertSameObservation = (next: GatewayServiceState) => {
    const before = identityFacts(state);
    const after = identityFacts(next);
    if (isDeepStrictEqual(before, after)) {
      return;
    }
    const { autoRestart: beforeRestart, ...beforeIdentity } = before;
    const { autoRestart: afterRestart, ...afterIdentity } = after;
    if (
      beforeRestart &&
      afterRestart &&
      isDeepStrictEqual(beforeIdentity, afterIdentity) &&
      beforeRestart.state === afterRestart.state &&
      beforeRestart.subState === afterRestart.subState &&
      typeof beforeRestart.restarts === "number" &&
      typeof afterRestart.restarts === "number" &&
      afterRestart.restarts > beforeRestart.restarts
    ) {
      // Advancing retries of the same failed candidate remain non-quiescent.
      // They do not establish a serving generation or drainage. Requiring a
      // stable counter here prevents the owned, journaled stop from ever being
      // dispatched when the supervisor restarts faster than these reads.
      // Restoration still requires a separate stopped readback after that stop;
      // the refusal-only continuity check rejects counter resets at every read.
      return;
    }
    if (
      beforeRestart &&
      nativeIdentity?.platform === "linux" &&
      nativeIdentity.scope === "user" &&
      before.unit === nativeIdentity.unitName &&
      before.managerUid === nativeIdentity.uid &&
      isDeepStrictEqual(definitionFacts(state), definitionFacts(next)) &&
      (after.unit === undefined || after.unit === before.unit) &&
      (after.managerUid === undefined || after.managerUid === before.managerUid) &&
      (after.pid === undefined || after.pid === 0)
    ) {
      if (
        after.status === "stopped" &&
        after.unit === before.unit &&
        after.managerUid === before.managerUid
      ) {
        // The failed supervisor settled during this interval. Do not combine
        // its old policy with the new stopped fact: obtain a full fresh read.
        throw new PendingNativeRuntimeObservation(unavailable("restart-settled").message);
      }
      if (after.status === "unknown" && next.runtime?.inspectionFailure) {
        // An incomplete closing runtime query has the same non-authoritative
        // meaning as an incomplete first query. No partial fact permits work.
        throw new PendingNativeRuntimeObservation(unavailable("restart-query").message);
      }
    }
    const afterFields: Record<string, unknown> = after;
    const changed = Object.entries(before)
      .filter(([key, value]) => !isDeepStrictEqual(value, afterFields[key]))
      .map(([key]) => key);
    throw unavailable(`native-identity:${changed.join(",")}`);
  };
  assertSameObservation(finalState);
  const finalEnabled = await service.isEnabled({ env: state.env, timeoutMs: remainingTimeout() });
  params.assertCurrent();
  if (enabled !== finalEnabled) {
    throw unavailable();
  }
  // Close the observation interval after the final policy await as well. A
  // concurrent native transition cannot borrow the preceding state snapshot.
  const closingState = await inspect();
  assertSameObservation(closingState);
  const binding = {
    runId: params.record.runId,
    stateDir: source.stateDir,
    configPath: source.configPath,
    profile: source.profile,
  };
  let identity: UpdateRecoveryNativeIdentity;
  let loaded: boolean;
  if (platform() === "darwin") {
    identity = {
      ...binding,
      platform: "darwin",
      domain: resolveLaunchAgentGuiDomain(),
      label: resolveLaunchAgentLabel(state.env),
    };
    loaded = state.loadState.status === "loaded";
  } else if (platform() === "linux") {
    const native = state.runtime?.systemd;
    const unitName = `${resolveSystemdServiceName(state.env)}.service`;
    if (
      native?.unit !== unitName ||
      typeof native.managerUid !== "number" ||
      !Number.isInteger(native.managerUid) ||
      native.managerUid < 0 ||
      native.managerUid >= 0xffffffff
    ) {
      throw unavailable();
    }
    // Ordinary inspection uses GetUnit; a live recovery owner may reload the
    // bound definition. Both paths verify effective properties and drained native
    // processes, independently of is-enabled policy and without starting it.
    identity = { ...binding, platform: "linux", scope: "user", unitName, uid: native.managerUid };
    loaded = true;
  } else if (platform() === "win32") {
    if (state.loadState.status !== "loaded") {
      throw unavailable();
    }
    identity = { ...binding, platform: "win32", taskName: resolveTaskName(state.env) };
    loaded = true;
  } else {
    throw unavailable();
  }
  return {
    identity,
    facts: { exists: true, enabled, loaded, stopped: state.runtime?.status === "stopped" },
  };
}
