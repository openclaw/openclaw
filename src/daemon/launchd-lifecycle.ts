/** LaunchAgent bootstrap recovery plus start and restart lifecycle controls. */
import { spawnSync } from "node:child_process";
import { formatPortDiagnostics } from "../infra/ports-format.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { cleanStaleGatewayProcessesSync } from "../infra/restart-stale-pids.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { isCurrentProcessInsideLaunchdService } from "./launchd-current-service.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { scheduleDetachedLaunchdRestartHandoff } from "./launchd-restart-handoff.js";
import {
  bootstrapLaunchAgentOrThrow,
  isLaunchctlAlreadyLoaded,
  isUnsupportedGuiDomain,
  parseLaunchctlJob,
  probeLaunchAgentState,
  readLaunchAgentRuntime,
  resolveLaunchAgentGatewayContext,
  resolveLaunchAgentGuiDomain,
} from "./launchd-runtime.js";
import {
  resolveLaunchAgentPlistPath,
  rewriteLaunchAgentPlistForRestart,
} from "./launchd-service-files.js";
import {
  assertNoSystemLaunchDaemonOwnership,
  isSystemLaunchDaemonOwnershipError,
} from "./launchd-system.js";
import { formatLine } from "./output.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import type {
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceRestartResult,
} from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  isUpdateOwnedGatewayServiceCommand,
} from "./service-update-authority.js";

const LAUNCHCTL_PROTECTED_PID_TIMEOUT_MS = 2_000;
function readLaunchAgentPidForCleanupSync(serviceTarget: string): number {
  const probe = spawnSync("launchctl", ["print", serviceTarget], {
    env: resolveServiceManagerEnv(),
    encoding: "utf8",
    timeout: LAUNCHCTL_PROTECTED_PID_TIMEOUT_MS,
  });
  const result = {
    stdout: probe.stdout ?? "",
    stderr: probe.error?.message ?? probe.stderr ?? "",
    code: probe.error ? 1 : (probe.status ?? 1),
  };
  if (result.code !== 0) {
    throw new Error(`launchctl print failed: ${formatLaunchctlResultDetail(result)}`);
  }
  const pid = parseLaunchctlJob(result.stdout || result.stderr || "", serviceTarget).runtime.pid;
  if (pid === undefined) {
    throw new Error("launchctl print did not report a running pid");
  }
  return pid;
}

type LaunchAgentBootstrapRepairResult =
  | { ok: true; status: "repaired" | "already-loaded" }
  | {
      ok: false;
      status: "bootstrap-failed" | "kickstart-failed";
      detail?: string;
    }
  | {
      ok: false;
      status: "system-launchdaemon-conflict" | "system-launchdaemon-unverifiable";
      detail: string;
    }
  | { ok: false; status: "gui-session-unavailable"; detail: string; domain: string };

export async function repairLaunchAgentBootstrap(args: {
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
}): Promise<LaunchAgentBootstrapRepairResult> {
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(env);
  const plistPath = resolveLaunchAgentPlistPath(env);
  const serviceTarget = `${domain}/${label}`;
  try {
    await assertNoSystemLaunchDaemonOwnership(label);
  } catch (error) {
    if (!isSystemLaunchDaemonOwnershipError(error)) {
      throw error;
    }
    return {
      ok: false,
      status:
        error.ownership.status === "unverifiable"
          ? "system-launchdaemon-unverifiable"
          : "system-launchdaemon-conflict",
      detail: error.message,
    };
  }
  // Rewrite first so legacy inline environment secrets move into the private
  // env file before the plist becomes world-readable for launchd.
  const warn = args.warn ?? ((message: string) => console.warn(formatLine("Warning", message)));
  await rewriteLaunchAgentPlistForRestart({ env, label, plistPath, warn });
  await execLaunchctl(["enable", serviceTarget]);
  const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
  if (boot.code === 0) {
    return { ok: true, status: "repaired" };
  }
  const detail = (boot.stderr || boot.stdout).trim();
  if (isUnsupportedGuiDomain(detail)) {
    return { ok: false, status: "gui-session-unavailable", detail, domain };
  }
  if (!isLaunchctlAlreadyLoaded(boot)) {
    return { ok: false, status: "bootstrap-failed", detail: detail || undefined };
  }

  // Service is already bootstrapped. Only kickstart if it is not actively running —
  // kickstarting a healthy running service causes unnecessary session disconnects.
  const runtime = await readLaunchAgentRuntime(env);
  if (runtime.status === "running") {
    return { ok: true, status: "already-loaded" };
  }

  const kick = await execLaunchctl(["kickstart", serviceTarget]);
  if (kick.code !== 0) {
    return {
      ok: false,
      status: "kickstart-failed",
      detail: (kick.stderr || kick.stdout).trim() || undefined,
    };
  }
  return { ok: true, status: "already-loaded" };
}
type LaunchAgentRestoreResult = { loaded: true } | { loaded: false; detail: string };

function writeLaunchAgentActionLine(
  stdout: NodeJS.WritableStream,
  label: string,
  value: string,
): void {
  try {
    stdout.write(`${formatLine(label, value)}\n`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") {
      throw err;
    }
  }
}

async function ensureLaunchAgentLoadedAfterFailure(params: {
  domain: string;
  serviceTarget: string;
  plistPath: string;
  onMutation?: (mode: "enable" | "bootstrap") => void;
  assertCurrent?: () => void;
  retryPendingTeardown?: boolean;
  preserveAutoStart?: boolean;
}): Promise<LaunchAgentRestoreResult> {
  params.assertCurrent?.();
  const probe = await execLaunchctl(["print", params.serviceTarget]);
  params.assertCurrent?.();
  if (probe.code === 0) {
    return { loaded: true };
  }
  try {
    await bootstrapLaunchAgentOrThrow({
      ...params,
      actionHint: "openclaw gateway start",
    });
    return { loaded: true };
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    // A failed restore is not recoverable by launchd: the label is gone, so
    // KeepAlive has nothing to respawn. Report it instead of dropping it.
    return { loaded: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function rethrowLaunchAgentActivationFailure(
  params: Parameters<typeof ensureLaunchAgentLoadedAfterFailure>[0],
  error: unknown,
): Promise<never> {
  if (hasCommandProcessCleanupError(error)) {
    throw error;
  }
  const restored = await ensureLaunchAgentLoadedAfterFailure(params);
  const failure = error instanceof Error ? error.message : String(error);
  throw new Error(
    restored.loaded
      ? `${failure}\nLaunchAgent ${params.serviceTarget} is loaded; launchd can retry its KeepAlive job. Run openclaw gateway status --deep to inspect startup.`
      : [
          failure,
          `LaunchAgent ${params.serviceTarget} is not loaded and could not be restored: ${restored.detail}`,
          "The gateway is down and launchd has no job left to respawn it.",
          `Fix: run \`openclaw gateway start\`, or \`launchctl bootstrap ${params.domain} ${params.plistPath}\`.`,
        ].join("\n"),
    { cause: error },
  );
}

async function needsLaunchAgentBootstrap(
  kickstart: Awaited<ReturnType<typeof execLaunchctl>>,
  serviceTarget: string,
  assertCurrent?: () => void,
): Promise<boolean> {
  if (kickstart.code === 0 || isLaunchctlNotLoaded(kickstart)) {
    return kickstart.code !== 0;
  }
  // Empty or generic kickstart output cannot establish whether the job exists.
  assertCurrent?.();
  const observed = await probeLaunchAgentState(serviceTarget);
  assertCurrent?.();
  return observed.state === "not-loaded";
}

async function prepareLaunchAgentActivation(
  args: GatewayServiceControlArgs,
  action: "start" | "restart",
) {
  const { assertCurrent, preserveAutoStart, preserveDefinition, onRestartAttempted } = args;
  const serviceEnv = args.env ?? (process.env as GatewayServiceEnv);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(serviceEnv);
  const plistPath = resolveLaunchAgentPlistPath(serviceEnv);
  const serviceTarget = `${domain}/${label}`;
  const reportMutation = createGatewayLifecycleMutationReporter(args.onMutation);
  await assertNoSystemLaunchDaemonOwnership(label);
  const bootstrap = {
    domain,
    serviceTarget,
    plistPath,
    onMutation: reportMutation,
    assertCurrent,
    preserveAutoStart,
    retryPendingTeardown: preserveDefinition,
  };
  const load = (options: { skipEnable?: boolean; retryPendingTeardown?: boolean } = {}) =>
    bootstrapLaunchAgentOrThrow({
      ...bootstrap,
      actionHint: `openclaw gateway ${action}`,
      ...options,
    });
  return {
    serviceEnv,
    label,
    plistPath,
    serviceTarget,
    reportMutation,
    async enable() {
      if (preserveAutoStart) {
        return false;
      }
      assertCurrent?.();
      const result = await execLaunchctl(["enable", serviceTarget]);
      if (result.code === 0) {
        reportMutation("enable");
      }
      return result.code === 0;
    },
    bootstrap: load,
    async kickstart(skipEnable?: boolean) {
      assertCurrent?.();
      if (action === "restart") {
        onRestartAttempted?.();
      }
      let start = await execLaunchctl([
        "kickstart",
        ...(action === "restart" ? ["-k"] : []),
        serviceTarget,
      ]);
      if (action === "restart" && start.code === 0) {
        reportMutation("kickstart");
        return;
      }
      if (await needsLaunchAgentBootstrap(start, serviceTarget, assertCurrent)) {
        await load({ skipEnable });
        // Loading only registers demand-only jobs. Without -k, an auto-started job stays running.
        if (action === "restart" && !preserveDefinition) {
          return;
        }
        assertCurrent?.();
        start = await execLaunchctl(["kickstart", serviceTarget]);
      }
      if (start.code !== 0) {
        throw new Error(`launchctl kickstart failed: ${start.stderr || start.stdout}`.trim());
      }
      if (action === "restart") {
        reportMutation("kickstart");
      }
    },
    rethrow: (error: unknown, retryPendingTeardown = preserveDefinition) =>
      rethrowLaunchAgentActivationFailure({ ...bootstrap, retryPendingTeardown }, error),
  };
}

export async function startLaunchAgent(params: GatewayServiceControlArgs): Promise<void> {
  const { stdout } = params;
  const activation = await prepareLaunchAgentActivation(params, "start");

  // Enable is an independent mutation; audit it even if the later launch fails.
  const enabled = await activation.enable();

  try {
    await activation.kickstart(enabled);
  } catch (error) {
    await activation.rethrow(error);
  }
  activation.reportMutation("kickstart");

  writeLaunchAgentActionLine(stdout, "Started LaunchAgent", activation.serviceTarget);
}

export async function restartLaunchAgent(
  params: GatewayServiceControlArgs,
): Promise<GatewayServiceRestartResult> {
  const { preserveDefinition, stdout, warn, assertCurrent } = params;
  const activation = await prepareLaunchAgentActivation(params, "restart");
  const { serviceEnv, label, plistPath, serviceTarget, reportMutation } = activation;

  const detached = await isCurrentProcessInsideLaunchdService(label);
  if (!detached) {
    const {
      env: cleanupEnv,
      port: cleanupPort,
      probeHosts,
    } = await resolveLaunchAgentGatewayContext(serviceEnv);
    if (cleanupPort !== null) {
      assertGatewayServiceUpdateCurrent();
      cleanStaleGatewayProcessesSync(cleanupPort, {
        env: cleanupEnv,
        assertCurrent: assertGatewayServiceUpdateCurrent,
        // Resolve after lsof captures its listener snapshot. A KeepAlive respawn
        // during enumeration must be protected before candidate filtering/signals.
        resolveProtectedPid: () => {
          const pid = readLaunchAgentPidForCleanupSync(serviceTarget);
          assertGatewayServiceUpdateCurrent();
          return pid;
        },
      });
      const diagnostics = await inspectPortUsage(cleanupPort, {
        probeHosts,
      }).catch(() => null);
      if (diagnostics?.status === "busy") {
        const runtime = await readLaunchAgentRuntime(serviceEnv);
        const managedPid = runtime.pid;
        // Only the current supervised PID may keep the port busy before a
        // disruptive restart. Re-read after cleanup to close over a concurrent
        // launchd respawn rather than trusting the protected pre-cleanup PID.
        const ownedByLaunchAgent =
          managedPid !== undefined &&
          diagnostics.listeners.length > 0 &&
          diagnostics.listeners.every((listener) => listener.pid === managedPid);
        if (!ownedByLaunchAgent) {
          throw new Error(
            [
              `gateway port ${cleanupPort} is busy but is not verifiably owned by LaunchAgent ${label}`,
              ...formatPortDiagnostics(diagnostics),
            ].join("\n"),
          );
        }
      }
    }
  }
  // Preservation permits native activation only, including detached handoffs.
  const plistReloadNeeded =
    !preserveDefinition &&
    (await rewriteLaunchAgentPlistForRestart({
      env: serviceEnv,
      label,
      plistPath,
      stdout,
      warn,
    }));
  // Restart requests issued from inside the managed gateway process tree need a
  // detached handoff. A direct `kickstart -k` would terminate the caller before
  // it can finish the restart command.
  if (detached) {
    if (isUpdateOwnedGatewayServiceCommand()) {
      throw new Error(
        "UPDATE_NATIVE_AUTHORITY: update-owned native restart requires an external executor, not a detached service handoff.",
      );
    }
    const handoff = scheduleDetachedLaunchdRestartHandoff({
      env: serviceEnv,
      mode: plistReloadNeeded ? "reload" : "kickstart",
      waitForPid: process.pid,
    });
    if (!handoff.ok) {
      throw new Error(`launchd restart handoff failed: ${handoff.error}`);
    }
    reportMutation(plistReloadNeeded ? "handoff-reload" : "handoff-kickstart");
    writeLaunchAgentActionLine(stdout, "Scheduled LaunchAgent restart", serviceTarget);
    return { outcome: "scheduled" };
  }

  // Explicit restart restores activation, including a service parked by Doctor.
  try {
    await activation.enable();

    if (plistReloadNeeded) {
      assertCurrent?.();
      const bootout = await execLaunchctl(["bootout", serviceTarget]);
      if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
        throw new Error(`launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`);
      }
      if (bootout.code === 0) {
        reportMutation("bootout");
      }
      await activation.bootstrap({ retryPendingTeardown: true });
    } else {
      await activation.kickstart();
    }
  } catch (error) {
    await activation.rethrow(error, preserveDefinition || plistReloadNeeded);
  }
  writeLaunchAgentActionLine(stdout, "Restarted LaunchAgent", serviceTarget);
  return { outcome: "completed" };
}
