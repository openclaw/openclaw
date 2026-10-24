// Respawns the gateway process when no supervisor handles restart.
import { spawn, type ChildProcess } from "node:child_process";
import { isSupported as isSystemdSupported } from "@openclaw/proc-safe/systemd";
import { resolveOpenClawCliInvocation } from "../../cli-invocation.mjs";
import { scheduleDetachedLaunchdRestartHandoff } from "../daemon/launchd-restart-handoff.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { mergeGatewayServiceEnv } from "../daemon/service-env-merge.js";
import type { GatewayServiceState } from "../daemon/service-types.js";
import {
  isWindowsTaskSupervisorChildArgument,
  readWindowsTaskSupervisorRestartExitCode,
} from "../daemon/windows-task-supervisor-contract.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  probeChildRuntimeExecutable,
  registerChildRuntimeRecovery,
} from "./child-runtime-viability.js";
import { isContainerEnvironment } from "./container-environment.js";
import { isTruthyEnvValue } from "./env.js";
import { formatErrorMessage } from "./errors.js";
import { readGatewayLastShutdownAsync } from "./gateway-boot-lifecycle.js";
import { rewritePnpmVersionedOpenClawEntryPath } from "./openclaw-root.js";
import type { GatewayRestartIntent } from "./restart-lifecycle.types.js";
import { requestGatewayRestartWithSignalAdmission, triggerOpenClawRestart } from "./restart.js";
import { detectGatewayRespawnSupervisor } from "./supervisor-markers.js";

type GatewayRespawnResult = {
  mode: "supervised" | "disabled" | "failed";
  detail?: string;
  exitCode?: number;
  handoffSpawned?: Promise<boolean>;
};

type GatewayUpdateRespawnResult =
  | { mode: "spawned"; pid?: number; child: ChildProcess }
  | { mode: "disabled" | "failed"; detail?: string };
type GatewayRespawnOptions = {
  env?: NodeJS.ProcessEnv;
  decision?: GatewayRestartDecision;
};

export type GatewayRestartDecision =
  | { mode: "disabled"; reason: "no-respawn" }
  | { mode: "disabled"; reason: "unmanaged"; detail: string }
  | {
      mode: "supervised";
      supervisor: NonNullable<ReturnType<typeof detectGatewayRespawnSupervisor>>;
    };

export function resolveGatewayRestartDecision(): GatewayRestartDecision {
  if (isTruthyEnvValue(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled", reason: "no-respawn" };
  }
  const supervisor = detectGatewayRespawnSupervisor(process.env);
  if (supervisor) {
    return { mode: "supervised", supervisor };
  }
  const detail =
    process.platform === "win32"
      ? "win32: detached respawn unsupported without Scheduled Task markers"
      : isContainerEnvironment()
        ? "container: use in-process restart to keep PID 1 alive"
        : "unmanaged: use in-process restart to keep custom supervisor PID tracking stable";
  return { mode: "disabled", reason: "unmanaged", detail };
}

const CHILD_RUNTIME_RESTART_REASON = "gateway.runtime-unavailable";
const NATIVE_WORKER_RESTART_REASON = "gateway.native-worker-unsettled";

type GatewayRuntimeRecoveryResult = {
  status: "restart-requested" | "report-only";
  reason: string;
};
type NativeWorkerRecoveryRequest = { isCurrent: () => boolean };
const nativeWorkerRecovery = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayNativeWorkerRecovery"),
  (): {
    request?: (params: NativeWorkerRecoveryRequest) => Promise<GatewayRuntimeRecoveryResult>;
  } => ({}),
);
const reportRecoveryOnly = (reason: string): GatewayRuntimeRecoveryResult => ({
  status: "report-only",
  reason: `Automatic runtime recovery is report-only: ${reason}`,
});

/** Worker owners retain native custody; only the registered process owner may restart. */
export function requestGatewayNativeWorkerRecovery(
  params: NativeWorkerRecoveryRequest,
): Promise<GatewayRuntimeRecoveryResult> {
  const request = nativeWorkerRecovery.request;
  if (!request) {
    return Promise.resolve(reportRecoveryOnly("no Gateway process lifecycle owns recovery."));
  }
  // Native retirement can outlive the request's cancelled work scope.
  return runInDetachedAsyncContext(() =>
    Promise.resolve()
      .then(() => request(params))
      .catch(() =>
        reportRecoveryOnly(
          "service or restart preparation failed. Inspect the native worker and restart through the service owner.",
        ),
      ),
  );
}

/** Bind automatic recovery to the existing process lifecycle, never a worker pool. */
export function registerGatewayRuntimeRecovery(params: {
  decision: GatewayRestartDecision;
  ownsProcessLifecycle: boolean;
  isCurrent: () => boolean;
}): () => void {
  const { decision } = params;
  // Native target detection can request a Node report, which waits for every worker.
  // Prepare the service capability before server workers can become stuck in native I/O.
  const serviceCapabilityReady =
    params.ownsProcessLifecycle &&
    decision.mode === "supervised" &&
    decision.supervisor === "systemd"
      ? isSystemdSupported()
      : true;
  // Read while the original executable still works. Once it fails, only resident facts are usable.
  const previousShutdown =
    params.ownsProcessLifecycle && decision.mode === "supervised"
      ? Promise.resolve().then(() => readGatewayLastShutdownAsync())
      : Promise.resolve(undefined);
  // Retain failure as a refusal, without an unhandled rejection before the first diagnosis.
  const history = previousShutdown.then(
    (shutdown) => ({ shutdown }),
    (error: unknown) => ({ error }),
  );
  let active = true;
  const recover = async (
    reason: string,
    isCurrent: () => boolean,
    intent?: GatewayRestartIntent,
  ): Promise<GatewayRuntimeRecoveryResult> => {
    if (
      !params.ownsProcessLifecycle ||
      decision.mode !== "supervised" ||
      decision.supervisor === "external"
    ) {
      return reportRecoveryOnly("no verified native service restart target.");
    }
    if (!serviceCapabilityReady) {
      return reportRecoveryOnly("native systemd inspection was unavailable at Gateway startup.");
    }
    const prior = await history;
    if ("error" in prior) {
      return reportRecoveryOnly("restart history could not be read.");
    }
    if (
      prior.shutdown?.reason?.includes(reason) &&
      Date.now() - prior.shutdown.completedAtMs < 5 * 60_000
    ) {
      return reportRecoveryOnly(
        "a runtime recovery restart happened within the last five minutes.",
      );
    }
    let service: GatewayServiceState;
    if (decision.supervisor === "launchd") {
      const { readLoadedLaunchAgentState, readCorrespondingLaunchAgentCommand } =
        await import("../daemon/launchd-runtime.js");
      const loaded = await readLoadedLaunchAgentState(process.env, { timeoutMs: 5_000 });
      // kickstart reuses the loaded job; a rewritten plist alone cannot prove its successor.
      const command = loaded.launchAgent
        ? await readCorrespondingLaunchAgentCommand(process.env, loaded.launchAgent, 5_000)
        : null;
      service = { ...loaded, command, env: mergeGatewayServiceEnv(process.env, command) };
    } else {
      const { resolveGatewayService } = await import("../daemon/service.js");
      const { readGatewayServiceState } = await import("../daemon/service-state.js");
      service = await readGatewayServiceState(resolveGatewayService(), {
        env: process.env,
        requireEffective: true,
        requireLoadedCommand: true,
        timeoutMs: 5_000,
      });
    }
    const executable = service.command?.programArguments[0];
    if (!service.running || !executable || !isNodeRuntime(executable)) {
      return reportRecoveryOnly("the service has no verified Node command.");
    }
    const probe = probeChildRuntimeExecutable(executable, {
      env: service.env,
      cwd: service.command?.workingDirectory,
    });
    if (probe.error || probe.status !== 0 || !/^v\d+\.\d+\.\d+\s*$/.test(probe.stdout)) {
      return reportRecoveryOnly(
        "the service Node cannot start. Repair the service runtime, then restart the Gateway.",
      );
    }
    // Do not wait for new admission after another lifecycle request has closed it.
    if (!active || !params.isCurrent()) {
      return reportRecoveryOnly("the Gateway lifecycle is already stopping.");
    }
    return runWithGatewayIndependentRootWorkAdmission(async () => {
      if (!active || !params.isCurrent()) {
        return reportRecoveryOnly("the Gateway lifecycle is already stopping.");
      }
      if (!isCurrent()) {
        return reportRecoveryOnly("the native worker has already settled.");
      }
      const result = intent
        ? requestGatewayRestartWithSignalAdmission(reason, intent)
        : requestGatewayRestartWithSignalAdmission(reason);
      return result.status === "emitted"
        ? {
            status: "restart-requested" as const,
            reason: intent?.requireFreshProcess
              ? "Service Node verified; requested a bounded fresh-process restart for the unsettled native worker."
              : "Service Node verified; requested a graceful fresh-process restart for the unavailable child runtime.",
          }
        : reportRecoveryOnly(`restart request ${result.status}.`);
    }, reason);
  };
  const releaseChildRecovery = registerChildRuntimeRecovery(() =>
    recover(CHILD_RUNTIME_RESTART_REASON, () => true),
  );
  let pending: Promise<GatewayRuntimeRecoveryResult> | undefined;
  let requested: GatewayRuntimeRecoveryResult | undefined;
  const unsettledWorkers = new Set<() => boolean>();
  const request = (worker: NativeWorkerRecoveryRequest) => {
    if (requested) {
      return Promise.resolve(requested);
    }
    unsettledWorkers.add(worker.isCurrent);
    pending ??= recover(
      NATIVE_WORKER_RESTART_REASON,
      () => [...unsettledWorkers].some((isCurrent) => isCurrent()),
      { force: true, waitMs: 0, requireFreshProcess: true },
    )
      .then((result) => {
        if (result.status === "restart-requested") {
          requested = result;
        }
        return result;
      })
      .finally(() => {
        pending = undefined;
        unsettledWorkers.clear();
      });
    return pending;
  };
  nativeWorkerRecovery.request = request;
  return () => {
    active = false;
    releaseChildRecovery();
    if (nativeWorkerRecovery.request === request) {
      nativeWorkerRecovery.request = undefined;
    }
  };
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - unmanaged environments: caller should keep in-process restart behavior so
 *   custom supervisors keep tracking the same gateway PID
 */
export function restartGatewayProcessWithFreshPid(
  opts: GatewayRespawnOptions = {},
): GatewayRespawnResult {
  const decision = opts.decision ?? resolveGatewayRestartDecision();
  if (decision.mode === "disabled") {
    return decision.reason === "no-respawn"
      ? { mode: "disabled" }
      : { mode: "disabled", detail: decision.detail };
  }
  const { supervisor } = decision;
  if (supervisor === "launchd") {
    const handoff = scheduleDetachedLaunchdRestartHandoff({
      mode: "start-after-exit",
      waitForPid: process.pid,
    });
    return handoff.ok
      ? { mode: "supervised", handoffSpawned: handoff.value }
      : { mode: "failed", detail: handoff.error };
  }
  if (supervisor === "schtasks") {
    if (process.argv.some(isWindowsTaskSupervisorChildArgument)) {
      const exitCode = readWindowsTaskSupervisorRestartExitCode(process.argv);
      if (exitCode === undefined) {
        return {
          mode: "failed",
          detail: "Windows task supervisor restart marker is missing or invalid",
        };
      }
      return {
        mode: "supervised",
        exitCode,
      };
    }
    const restart = triggerOpenClawRestart();
    if (!restart.ok) {
      return {
        mode: "failed",
        detail: restart.detail ?? `${restart.method} restart failed`,
      };
    }
  }
  return { mode: "supervised" };
}

/**
 * Update restarts must replace the OS process so the new code runs from a
 * fresh module graph after package files have changed on disk.
 *
 * The caller resolves supervisor ownership first; this path is only for an
 * unmanaged process whose installed package contents have been replaced.
 */
export function respawnGatewayProcessForUpdate(
  opts: GatewayRespawnOptions = {},
): GatewayUpdateRespawnResult {
  const decision = opts.decision ?? resolveGatewayRestartDecision();
  if (decision.mode === "disabled" && decision.reason === "no-respawn") {
    return { mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" };
  }
  try {
    const [entryArg, ...entryArgs] = process.argv.slice(1);
    const invocation = resolveOpenClawCliInvocation({
      entryPath: entryArg ? rewritePnpmVersionedOpenClawEntryPath(entryArg) : undefined,
      args: entryArgs,
    });
    const child = spawn(invocation.command, invocation.args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      detached: true,
      stdio: "inherit",
    });
    // Register before unref: late detached-spawn failures must not crash the parent.
    child.on("error", () => {});
    child.unref();
    return { mode: "spawned", pid: child.pid ?? undefined, child };
  } catch (err) {
    return { mode: "failed", detail: formatErrorMessage(err) };
  }
}
