/** LaunchAgent stop semantics and in-service maintenance parking. */
import { isDeepStrictEqual } from "node:util";
import { readLockPayloadSync, resolveGatewayLockPaths } from "../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { formatPortDiagnostics } from "../infra/ports-format.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { probePortUsage } from "../infra/ports-probe.js";
import { GatewayRestartPreparationError } from "../infra/restart-intent-error.js";
import {
  prepareGatewayRestartIntentLegacyProcess,
  writeGatewayServiceRestartIntentSync,
} from "../infra/restart-intent.js";
import { cleanStaleGatewayProcessesSync } from "../infra/restart-stale-pids.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import { createManagedHandoffLeaseStore } from "../infra/update-managed-service-handoff-lease.js";
import {
  getFileLockProcessStartTime,
  isPidAlive,
  isPidDefinitelyDead,
} from "../shared/pid-alive.js";
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
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  resolveLaunchAgentGatewayContext,
  resolveLaunchAgentGuiDomain,
} from "./launchd-runtime.js";
import { formatLine } from "./output.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import { createGatewayLifecycleMutationReporter } from "./service-mutation.js";
import type { GatewayServiceControlArgs, GatewayServiceEnv } from "./service-types.js";
import {
  assertGatewayServiceUpdateCurrent,
  isUpdateOwnedGatewayServiceCommand,
} from "./service-update-authority.js";

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

  const updateOwned = isUpdateOwnedGatewayServiceCommand();
  let intentEnv = serviceEnv;
  const assertNativeCurrent = () => {
    assertCurrent?.();
    assertGatewayServiceUpdateCurrent();
  };
  const insideService = await isCurrentProcessInsideLaunchdService(label, process.env);
  const assertStopCurrent = async () => {
    assertNativeCurrent();
    // Classify from the live lease too: losing an inherited marker cannot turn a
    // transferred executor into a direct-original updater. The row is not a grant;
    // both the captured caller fence and the handoff owner must still be current.
    const handoff =
      updateOwned && updateHandoff
        ? createManagedHandoffLeaseStore().read(resolveUpdateInstallRoot(updateHandoff.root))
        : undefined;
    const transferred =
      handoff?.kind === "current" &&
      (handoff.lease.helper.pid !== handoff.lease.executor.pid ||
        handoff.lease.helper.startIdentity !== handoff.lease.executor.startIdentity);
    if (
      insideService ||
      transferred ||
      (updateOwned && intentEnv.OPENCLAW_UPDATE_RUN_HANDOFF === "1")
    ) {
      // Retain the ancestry decision after bootout; losing the label does not
      // make a delegated updater an independent operator.
      const authorized =
        updateOwned &&
        updateHandoff &&
        (await (
          await import("../infra/update-managed-service-handoff.js")
        ).isCurrentManagedServiceUpdateHandoffProcess({ ...updateHandoff, env: intentEnv }));
      if (!authorized) {
        throw launchAgentStopError(
          serviceTarget,
          `Refusing to stop LaunchAgent ${label} from inside the same launchd service`,
        );
      }
    }
    assertNativeCurrent();
  };
  await assertStopCurrent();
  const initialPid = verifyLaunchAgentStopProbe(
    serviceTarget,
    await probeLaunchAgentState(serviceTarget, 5_000),
  );
  let clearIntent: (() => void) | undefined;
  let assertServingCurrent = assertNativeCurrent;
  let warning: string | undefined;
  try {
    if (updateOwned) {
      const command = await readLaunchAgentProgramArguments(serviceEnv, { requireEffective: true });
      assertNativeCurrent();
      if (!command) {
        throw new GatewayRestartPreparationError("service-command");
      }
      intentEnv = mergeGatewayServiceEnv(serviceEnv, command);
      await assertStopCurrent();
      const owner = readGatewayOwnerLease({ env: intentEnv, current: true });
      const legacyLockPath = owner ? undefined : resolveGatewayLockPaths(intentEnv).stateLockPath;
      const legacyLock = legacyLockPath ? readLockPayloadSync(legacyLockPath, true) : undefined;
      const legacyProcess = await prepareGatewayRestartIntentLegacyProcess({
        env: intentEnv,
        command,
        runtimePid: initialPid,
        readRuntime: () => readLaunchAgentRuntime(serviceEnv),
        assertCurrent: assertNativeCurrent,
      });
      const currentProbe = await probeLaunchAgentState(serviceTarget, 5_000);
      await assertStopCurrent();
      if (verifyLaunchAgentStopProbe(serviceTarget, currentProbe) !== initialPid) {
        throw new GatewayRestartPreparationError("serving-owner");
      }
      const assertIntentCurrent = () => {
        assertNativeCurrent();
        // Published Gateways can have only a file lock. An absent SQLite owner
        // cannot attest that the native wrapper or its serving child is unchanged.
        if (
          legacyProcess &&
          (!legacyLock ||
            !legacyLockPath ||
            !isPidAlive(legacyProcess.pid) ||
            getFileLockProcessStartTime(legacyProcess.pid, intentEnv) !== legacyProcess.startTime ||
            !isPidAlive(legacyLock.pid) ||
            getFileLockProcessStartTime(legacyLock.pid, intentEnv) !== legacyLock.startTime ||
            !isDeepStrictEqual(legacyLock, readLockPayloadSync(legacyLockPath, true)))
        ) {
          throw new GatewayRestartPreparationError("serving-owner");
        }
        const currentOwner = readGatewayOwnerLease({ env: intentEnv, current: true });
        if (
          currentOwner?.owner !== owner?.owner ||
          currentOwner?.pid !== owner?.pid ||
          currentOwner?.startedAt !== owner?.startedAt ||
          currentOwner?.state !== owner?.state
        ) {
          throw new GatewayRestartPreparationError("serving-owner");
        }
      };
      assertServingCurrent = assertIntentCurrent;
      // False means a verified stopped service with no serving owner. Recording
      // failure for a serving process throws; never treat it as best-effort.
      writeGatewayServiceRestartIntentSync({
        env: intentEnv,
        service: { kind: "launchd", name: label },
        nativePid: initialPid,
        nativeStopped: currentProbe.state !== "running",
        legacyProcess,
        reason: "update.run",
        assertCurrent: assertIntentCurrent,
        onRecorded: (clear) => {
          clearIntent = clear;
        },
      });
    }
    if (persistDisable) {
      await assertStopCurrent();
      assertServingCurrent();
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
    assertServingCurrent();
    const bootout = await execLaunchctl(["bootout", serviceTarget], LAUNCH_AGENT_STOP_TIMEOUT_MS);
    if (bootout.code !== 0 && !isLaunchctlNotLoaded(bootout)) {
      throw launchAgentStopError(
        serviceTarget,
        `launchctl bootout failed: ${formatLaunchctlResultDetail(bootout)}`,
      );
    }
  } catch (error) {
    // Revocation can close native authority; compare-and-clear still owns only our row.
    clearIntent?.();
    throw error;
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
