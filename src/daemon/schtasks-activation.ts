import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { sleep } from "../utils.js";
import { resolveGatewayServiceProbeHosts } from "./gateway-service-probe-hosts.js";
import { execSchtasks } from "./schtasks-exec.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";
import {
  findInstalledProcessPid,
  isNodeHostArgv,
  readWindowsProcessSnapshot,
} from "./schtasks-process-snapshot.js";
import {
  resolveScheduledTaskCommandPort,
  resolveScheduledTaskOwnedGatewayPids,
  shouldManageGatewayListenerPort,
} from "./schtasks-process.js";
import {
  launchFallbackTaskScript,
  readScheduledTaskRuntime,
  SCHEDULED_TASK_FALLBACK_POLL_MS,
  SCHEDULED_TASK_FALLBACK_TIMEOUT_MS,
} from "./schtasks-runtime.js";
import { probeScheduledTaskState } from "./schtasks-state-probe.js";
import type { GatewayServiceControlArgs, GatewayServiceEnv } from "./service-types.js";

export type ScheduledTaskActivation = "scheduled-task" | "direct-fallback";

async function shouldFallbackScheduledTaskLaunch(params: {
  env: GatewayServiceEnv;
  scriptPath: string;
}): Promise<boolean> {
  const readLaunchObservation = async (timeoutMs?: number) => {
    const runtime = await readScheduledTaskRuntime(params.env, { timeoutMs }).catch(() => null);
    let state: "running" | "not-yet-run" | "stopped-success" | "other" = "other";
    if (runtime?.status === "running") {
      state = "running";
    } else if (runtime?.status === "stopped") {
      // SCHED_S_TASK_HAS_NOT_RUN is history, and only a stopped task is a fallback candidate.
      if (runtime.lastRunResult === "267011") {
        state = "not-yet-run";
      } else if (runtime.lastRunResult === "0") {
        state = "stopped-success";
      }
    }
    return {
      state,
      signature: [runtime?.state, runtime?.lastRunTime, runtime?.lastRunResult, runtime?.detail]
        .filter(Boolean)
        .join("|"),
    };
  };

  const hasLaunchEvidence = async (): Promise<boolean> => {
    const command = await readScheduledTaskCommand(params.env).catch(() => null);
    const installedArguments = command?.programArguments;
    const taskPort = resolveScheduledTaskCommandPort(params.env, command);
    const manageGatewayPort = shouldManageGatewayListenerPort(params.env);
    if (manageGatewayPort && taskPort) {
      const probeHosts = await resolveGatewayServiceProbeHosts({ env: params.env, command });
      const ownedPids = await resolveScheduledTaskOwnedGatewayPids(
        params.env,
        { port: taskPort, probeHosts },
        command,
      );
      if (ownedPids.length > 0) {
        return true;
      }
    }

    const scriptPathNeedle = normalizeLowercaseStringOrEmpty(
      params.scriptPath.replaceAll("/", "\\"),
    );
    if (!scriptPathNeedle) {
      return false;
    }
    const entries = readWindowsProcessSnapshot();
    if (!entries) {
      return false;
    }
    if (
      entries.some((entry) =>
        normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "")
          .replaceAll("/", "\\")
          .includes(scriptPathNeedle),
      )
    ) {
      return true;
    }
    if (!taskPort) {
      return false;
    }
    if (!installedArguments?.length) {
      return false;
    }
    return (
      findInstalledProcessPid(
        entries,
        taskPort,
        installedArguments,
        manageGatewayPort
          ? (argv) => classifyOpenClawArgv(argv, { command: "gateway" }).kind === "openclaw"
          : isNodeHostArgv,
      ) != null
    );
  };

  let previous = await readLaunchObservation();
  if (previous.state !== "not-yet-run" && previous.state !== "stopped-success") {
    return false;
  }
  const deadline = Date.now() + SCHEDULED_TASK_FALLBACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(SCHEDULED_TASK_FALLBACK_POLL_MS);
    // Periodic observations keep their existing short budget after the initial cold read.
    const current = await readLaunchObservation(5_000);
    if (current.state !== "not-yet-run" && current.state !== "stopped-success") {
      return false;
    }
    if (
      current.state === "not-yet-run" &&
      previous.state === "not-yet-run" &&
      current.signature !== previous.signature
    ) {
      return false;
    }
    // A queued task may finish before its process is observable; the reverse transition means a new run is starting.
    if (previous.state === "stopped-success" && current.state === "not-yet-run") {
      return false;
    }
    previous = current;
    if (await hasLaunchEvidence()) {
      return false;
    }
  }
  return true;
}

export async function runScheduledTaskOrThrow(params: {
  taskName: string;
  env: GatewayServiceEnv;
  scriptPath: string;
  onMutation?: () => void;
  assertCurrent?: () => void;
  prepareEffect?: GatewayServiceControlArgs["prepareEffect"];
  allowFallback?: boolean;
}): Promise<ScheduledTaskActivation> {
  params.assertCurrent?.();
  const previous = params.prepareEffect ? probeScheduledTaskState(params.taskName) : undefined;
  if (params.prepareEffect) {
    if (previous?.status !== "found" || (previous.state !== 1 && previous.state !== 3)) {
      throw new Error("Scheduled Task was not verified idle before custody release.");
    }
    await params.prepareEffect();
    params.assertCurrent?.();
  }
  const run = await execSchtasks(["/Run", "/TN", params.taskName]);
  if (run.code !== 0) {
    throw new Error(`schtasks run failed: ${run.stderr || run.stdout}`.trim());
  }
  params.onMutation?.();
  if (previous?.status === "found") {
    // The predecessor has released SQLite custody. Only Scheduler facts are
    // suitable here; readiness and process ownership are the successor's proof.
    const deadline = performance.now() + SCHEDULED_TASK_FALLBACK_TIMEOUT_MS;
    while (performance.now() < deadline) {
      const current = probeScheduledTaskState(params.taskName, deadline - performance.now());
      if (current.status !== "found") {
        break;
      }
      if (current.state === 4 || current.lastRunTime !== previous.lastRunTime) {
        return "scheduled-task";
      }
      await sleep(
        Math.max(0, Math.min(SCHEDULED_TASK_FALLBACK_POLL_MS, deadline - performance.now())),
      );
    }
    throw new Error(
      "/Run was accepted, but Scheduler activation could not be verified; no fallback was started.",
    );
  }
  if (
    !(await shouldFallbackScheduledTaskLaunch({ env: params.env, scriptPath: params.scriptPath }))
  ) {
    return "scheduled-task";
  }
  if (params.allowFallback !== false && !shouldManageGatewayListenerPort(params.env)) {
    await launchFallbackTaskScript(params.env, undefined, params.assertCurrent);
    return "direct-fallback";
  }
  throw new Error(
    `Scheduled Task ${params.taskName} did not start within ${SCHEDULED_TASK_FALLBACK_TIMEOUT_MS / 1000}s after schtasks /Run; refusing a direct fallback because the queued task could still start.`,
  );
}
