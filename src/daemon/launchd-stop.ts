/** LaunchAgent stop semantics and in-service maintenance parking. */
import { formatPortDiagnostics } from "../infra/ports-format.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { probePortUsage } from "../infra/ports-probe.js";
import { cleanStaleGatewayProcessesSync } from "../infra/restart-stale-pids.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { sleep } from "../utils.js";
import { isCurrentProcessInsideLaunchdService } from "./launchd-current-service.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
} from "./launchd-exec.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "./launchd-plist.js";
import { scheduleDetachedLaunchdMaintenancePark } from "./launchd-restart-handoff.js";
import {
  probeLaunchAgentState,
  resolveLaunchAgentGatewayContext,
  resolveLaunchAgentGuiDomain,
} from "./launchd-runtime.js";
import { formatLine } from "./output.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import type { GatewayServiceControlArgs, GatewayServiceEnv } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

const LAUNCH_AGENT_STOP_PORT_RELEASE_TIMEOUT_MS = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000;
const LAUNCH_AGENT_STOP_PORT_RELEASE_POLL_MS = 100;
// launchd owns the graceful-exit deadline; allow teardown bookkeeping afterward.
const LAUNCH_AGENT_STOP_TIMEOUT_MS = (LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS + 10) * 1_000;

function launchAgentStopError(serviceTarget: string, detail: string): Error {
  return new Error(
    `${detail}. Run \`launchctl bootout ${serviceTarget}\` from an external terminal in the service owner's logged-in macOS GUI session.`,
  );
}

function verifyLaunchAgentStopProbe(
  serviceTarget: string,
  probe: Awaited<ReturnType<typeof probeLaunchAgentState>>,
): number | undefined {
  if (probe.state === "unknown") {
    throw launchAgentStopError(
      serviceTarget,
      `launchctl print could not verify LaunchAgent stop: ${probe.detail ?? "unknown error"}`,
    );
  }
  if (probe.state !== "running") {
    return undefined;
  }
  if (probe.runtime.pid === undefined) {
    throw launchAgentStopError(
      serviceTarget,
      "launchctl print reported a running job without a PID",
    );
  }
  return probe.runtime.pid;
}

async function waitForLaunchAgentUnloaded(
  serviceTarget: string,
  initialPid: number | undefined,
  assertCurrent?: () => void,
): Promise<void> {
  const pids = new Set<number>(initialPid === undefined ? [] : [initialPid]);
  const deadline = Date.now() + LAUNCH_AGENT_STOP_TIMEOUT_MS;
  for (;;) {
    const probe = await probeLaunchAgentState(serviceTarget, 5_000);
    assertCurrent?.();
    const observedPid = verifyLaunchAgentStopProbe(serviceTarget, probe);
    if (observedPid !== undefined) {
      pids.add(observedPid);
    }
    const alivePids = [...pids].filter((pid) => !isPidDefinitelyDead(pid));
    if (probe.state === "not-loaded" && alivePids.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw launchAgentStopError(
        serviceTarget,
        `LaunchAgent stop did not complete: ${serviceTarget} is ${probe.state === "not-loaded" ? "unloaded" : "still loaded"}${alivePids.length ? `; PID ${alivePids.join(", ")} is still alive` : ""}`,
      );
    }
    await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
  }
}

async function waitForGatewayPortRelease(
  port: number,
  probeHosts: readonly string[],
): Promise<boolean> {
  const deadline = Date.now() + LAUNCH_AGENT_STOP_PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(Math.min(LAUNCH_AGENT_STOP_PORT_RELEASE_POLL_MS, deadline - Date.now()));
    const status = await probePortUsage(port, probeHosts);
    if (status === "free") {
      return true;
    }
  }
  return false;
}

async function assertGatewayPortReleasedAfterStop(
  env: GatewayServiceEnv,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  const { env: cleanupEnv, port, probeHosts } = await resolveLaunchAgentGatewayContext(env);
  if (port === null) {
    return;
  }
  await assertCurrent();
  assertGatewayServiceUpdateCurrent();
  cleanStaleGatewayProcessesSync(port, {
    env: cleanupEnv,
    assertCurrent: assertGatewayServiceUpdateCurrent,
  });
  const diagnostics = await inspectPortUsage(port, {
    probeHosts,
  }).catch(() => null);
  if (diagnostics?.status !== "busy") {
    return;
  }
  if (await waitForGatewayPortRelease(port, probeHosts)) {
    return;
  }
  throw new Error(
    [
      `gateway port ${port} is still busy after LaunchAgent stop`,
      ...formatPortDiagnostics(diagnostics),
    ].join("\n"),
  );
}

export async function stopLaunchAgent({
  stdout,
  env,
  disable: persistDisable,
  onMutation,
  assertCurrent,
  updateHandoff,
}: GatewayServiceControlArgs): Promise<void> {
  const serviceEnv = env ?? (process.env as GatewayServiceEnv);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(serviceEnv);
  const serviceTarget = `${domain}/${label}`;
  const reportMutation = createGatewayLifecycleMutationReporter(onMutation);

  const insideService = await isCurrentProcessInsideLaunchdService(label, process.env);
  const assertStopCurrent = async () => {
    if (insideService) {
      // Retain the ancestry decision after bootout; losing the label does not
      // make a delegated updater an independent operator.
      const authorized =
        updateHandoff &&
        (await (
          await import("../infra/update-managed-service-handoff.js")
        ).isCurrentManagedServiceUpdateHandoffProcess(updateHandoff));
      if (!authorized) {
        throw launchAgentStopError(
          serviceTarget,
          `Refusing to stop LaunchAgent ${label} from inside the same launchd service`,
        );
      }
    }
    assertCurrent?.();
  };
  await assertStopCurrent();
  const initialPid = verifyLaunchAgentStopProbe(
    serviceTarget,
    await probeLaunchAgentState(serviceTarget, 5_000),
  );
  let warning: string | undefined;
  if (persistDisable) {
    await assertStopCurrent();
    const disabled = await execLaunchctl(["disable", serviceTarget]);
    if (disabled.code === 0) {
      reportMutation("disable");
    } else {
      warning = `launchctl disable failed; used bootout fallback without persisting disable: ${formatLaunchctlResultDetail(disabled)}`;
    }
  }

  // A stopped but loaded job can still respawn. Both stop modes must boot it out;
  // --disable additionally preserves the operator's policy across login/reboot.
  await assertStopCurrent();
  const bootout = await execLaunchctl(["bootout", serviceTarget], LAUNCH_AGENT_STOP_TIMEOUT_MS);
  if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
    throw launchAgentStopError(
      serviceTarget,
      `launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`,
    );
  }
  reportMutation(persistDisable ? "disable-bootout" : "bootout");
  await waitForLaunchAgentUnloaded(serviceTarget, initialPid, assertCurrent);
  if (warning) {
    stdout.write(`${formatLine("Warning", warning)}\n`);
  }
  await assertGatewayPortReleasedAfterStop(serviceEnv, assertStopCurrent);
  assertCurrent?.();
  stdout.write(
    `${formatLine(warning ? "Stopped LaunchAgent (degraded)" : "Stopped LaunchAgent", serviceTarget)}\n`,
  );
}

export async function parkCurrentLaunchAgentForMaintenance(
  params: {
    env?: GatewayServiceEnv;
  } = {},
): Promise<boolean> {
  const serviceEnv = params.env ?? (process.env as GatewayServiceEnv);
  const domain = resolveLaunchAgentGuiDomain();
  const label = resolveLaunchAgentLabel(serviceEnv);
  if (!(await isCurrentProcessInsideLaunchdService(label, process.env))) {
    return false;
  }
  const serviceTarget = `${domain}/${label}`;
  // Disable before exit so KeepAlive cannot spawn a replacement before the
  // detached handoff can boot the current job out of launchd.
  const disable = await execLaunchctl(["disable", serviceTarget]);
  if (disable.code !== 0) {
    throw new Error(
      `launchctl disable failed while parking ${serviceTarget}: ${formatLaunchctlResultDetail(disable)}`,
    );
  }
  const handoff = scheduleDetachedLaunchdMaintenancePark({
    env: serviceEnv,
    waitForPid: process.pid,
  });
  const handoffError = !handoff.ok
    ? handoff.error
    : (await handoff.value)
      ? undefined
      : "helper failed to spawn";
  if (handoffError) {
    const rollback = await execLaunchctl(["enable", serviceTarget]);
    const rollbackDetail =
      rollback.code === 0
        ? "restored launchd enable state"
        : `launchctl enable rollback failed: ${formatLaunchctlResultDetail(rollback)}`;
    throw new Error(`launchd maintenance park handoff failed: ${handoffError}; ${rollbackDetail}`);
  }
  return true;
}
