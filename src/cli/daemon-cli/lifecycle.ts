// Gateway service lifecycle runners, including unmanaged-process fallbacks and restart health checks.
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveGatewayServiceProbeHosts } from "../../daemon/gateway-service-probe-hosts.js";
import {
  assertGatewayServiceUpdateCurrent,
  assertGatewayServiceFallbackAllowed,
} from "../../daemon/service-update-authority.js";
import { resolveGatewayService } from "../../daemon/service.js";
import {
  findInstalledSystemdGatewayScope,
  restartSystemdService,
  stopSystemdService,
} from "../../daemon/systemd.js";
import {
  type GatewayLockIdentity,
  isSameGatewayLockIdentity,
  readActiveGatewayLockIdentity,
  readActiveGatewayLockPort,
} from "../../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import {
  formatGatewayPidList,
  signalVerifiedGatewayPidSync,
} from "../../infra/gateway-processes.js";
import {
  assertGatewayServiceMutationAllowed,
  formatExternalSupervisorActionRequired,
  isGatewayExternallySupervised,
  resolveGatewayServiceMutationError,
} from "../../infra/gateway-supervision.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { resolveGatewayRestartDrainTimeoutMs } from "../../infra/restart-budget.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  isTerminalInteractive,
  NON_INTERACTIVE_GATEWAY_STOP_MESSAGE,
} from "../terminal-interactivity.js";
import { recoverInstalledLaunchAgent } from "./launchd-recovery.js";
import {
  appendGatewayLifecycleAudit,
  createGatewayLifecycleMutationAudit,
} from "./lifecycle-audit.js";
import { resolveGatewayConfigPorts, resolveGatewayLifecycleContext } from "./lifecycle-context.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "./lifecycle-core.js";
import {
  runSafeGatewayRestart,
  resolveGatewayRestartIntentOptions,
} from "./lifecycle-safe-restart.js";
import { resolveVerifiedGatewayListenerPids, signalGatewayRestart } from "./lifecycle-unmanaged.js";
import { createDaemonActionContext, createNullWriter } from "./response.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
  formatGatewayRestartFailure,
  renderGatewayPortHealthDiagnostics,
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyListener,
  waitForGatewayHealthyRestart,
} from "./restart-health.js";
import { renderGatewayServiceStartHints } from "./shared.js";
import { verifyGatewayStartReadiness } from "./start-health.js";
import { repairLoadedGatewayServiceForStart } from "./start-repair.js";
import type { DaemonLifecycleOptions } from "./types.js";

const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = DEFAULT_RESTART_HEALTH_DELAY_MS;
const WINDOWS_POST_RESTART_HEALTH_TIMEOUT_MS = 180_000;

function postRestartHealthAttempts(): number {
  return process.platform === "win32"
    ? Math.ceil(WINDOWS_POST_RESTART_HEALTH_TIMEOUT_MS / POST_RESTART_HEALTH_DELAY_MS)
    : POST_RESTART_HEALTH_ATTEMPTS;
}

async function handleSystemScopeSystemdGateway(
  action: "stop",
): Promise<{ result: "stopped"; message: string } | null>;
async function handleSystemScopeSystemdGateway(
  action: "restart",
): Promise<{ result: "restarted"; message: string } | null>;
async function handleSystemScopeSystemdGateway(
  action: "stop" | "restart",
): Promise<{ result: "stopped" | "restarted"; message: string } | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const installed = await findInstalledSystemdGatewayScope(process.env).catch(() => null);
  if (installed?.scope !== "system") {
    return null;
  }
  const stdout = createNullWriter();
  if (action === "stop") {
    assertGatewayServiceMutationAllowed("stop the gateway");
    await stopSystemdService({
      stdout,
      env: process.env,
      onMutation: createGatewayLifecycleMutationAudit({ action: "stop" }),
    });
    return {
      result: "stopped",
      message: `Gateway stopped via system-scope systemd unit ${installed.unitName}.`,
    };
  }
  assertGatewayServiceMutationAllowed("restart the gateway");
  await restartSystemdService({
    stdout,
    env: process.env,
    onMutation: createGatewayLifecycleMutationAudit({ action: "restart" }),
  });
  return {
    result: "restarted",
    message: `Gateway restarted via system-scope systemd unit ${installed.unitName}.`,
  };
}

async function stopGatewayWithoutServiceManager(
  port: number,
  lockOwnerPid: number | undefined,
  serviceContext?: Parameters<typeof resolveGatewayServiceProbeHosts>[0],
  selectedStateLock?: GatewayLockIdentity,
) {
  const managed = await handleSystemScopeSystemdGateway("stop");
  if (managed) {
    return managed;
  }
  const listenerPids = resolveVerifiedGatewayListenerPids(port);
  if (selectedStateLock) {
    if (listenerPids.some((pid) => pid !== selectedStateLock.pid)) {
      throw new Error(
        `Gateway listener on port ${port} does not match the selected-state lock owner; leaving it running.`,
      );
    }
    const currentLock = await readActiveGatewayLockIdentity({ requireInspection: true });
    if (
      !currentLock ||
      !isSameGatewayLockIdentity(selectedStateLock, currentLock) ||
      currentLock.pid !== selectedStateLock.pid ||
      currentLock.port !== port
    ) {
      throw new Error("Gateway lock changed before isolated stop; leaving every process running.");
    }
    const owner = readGatewayOwnerLease({ current: true });
    if (
      !owner ||
      owner.state !== "live" ||
      owner.mode !== "foreground" ||
      owner.owner !== currentLock.ownerId ||
      owner.pid !== currentLock.pid ||
      owner.port !== currentLock.port
    ) {
      throw new Error(
        `Cannot verify the live foreground Gateway owner for isolated state; leaving it running. Run ${formatCliCommand("openclaw gateway status --deep")} or use its supervisor.`,
      );
    }
  }
  // Listener discovery needs lsof, which minimal containers omit. The gateway
  // lock already names the verified owner of this port, so signal it instead of
  // reporting the gateway as not running while it keeps serving.
  const pids = selectedStateLock
    ? [selectedStateLock.pid]
    : listenerPids.length > 0
      ? listenerPids
      : lockOwnerPid
        ? [lockOwnerPid]
        : [];
  if (pids.length === 0) {
    const probeHosts = await resolveGatewayServiceProbeHosts(serviceContext ?? {});
    const portUsage = await probePortUsage(port, probeHosts);
    if (portUsage !== "free") {
      throw new Error(
        portUsage === "busy"
          ? `Port ${port} is in use but the owning process could not be identified. Run ${formatCliCommand("openclaw gateway status --deep")} to diagnose.`
          : `Could not determine whether port ${port} is still in use, so the gateway cannot be confirmed stopped. Run ${formatCliCommand("openclaw gateway status --deep")} to diagnose.`,
      );
    }
    return null;
  }
  for (const pid of pids) {
    signalVerifiedGatewayPidSync(pid, "SIGTERM");
    appendGatewayLifecycleAudit({
      action: "stop",
      source: "cli",
      mode: "sigterm",
      pid,
    });
  }
  return {
    result: "stopped" as const,
    message: `Gateway stop signal sent to unmanaged process${pids.length === 1 ? "" : "es"} on port ${port}: ${formatGatewayPidList(pids)}.`,
  };
}

function resolveRestartListenerHealthWait(restartIntent: GatewayRestartIntent | undefined) {
  const drainTimeoutMs = resolveGatewayRestartDrainTimeoutMs(restartIntent);
  const attempts =
    postRestartHealthAttempts() + Math.ceil((drainTimeoutMs ?? 0) / POST_RESTART_HEALTH_DELAY_MS);
  return {
    attempts,
    waitIndefinitelyForPreviousOwner: drainTimeoutMs === undefined,
    timeoutSeconds: Math.round((attempts * POST_RESTART_HEALTH_DELAY_MS) / 1000),
  };
}

async function restartUnmanaged(port: number, intent?: GatewayRestartIntent, allowSystem = true) {
  const managed = allowSystem ? await handleSystemScopeSystemdGateway("restart") : null;
  if (managed) {
    return managed;
  }
  return await signalGatewayRestart(port, {
    restartIntent: intent,
    enforceRestartConfig: true,
    processLabel: "unmanaged",
    auditSource: "cli",
  });
}

function isGatewaySignalRestartResult(
  result: Awaited<ReturnType<typeof restartUnmanaged>>,
): result is NonNullable<Awaited<ReturnType<typeof signalGatewayRestart>>> {
  return result !== null && "pid" in result && typeof result.pid === "number";
}

async function runExternalSupervisorRestart(opts: DaemonLifecycleOptions): Promise<boolean> {
  const { emitMessage, fail } = createDaemonActionContext({
    action: "restart",
    json: Boolean(opts.json),
  });
  const restartIntent = resolveGatewayRestartIntentOptions(opts);
  const lockIdentity = await readActiveGatewayLockIdentity().catch(() => undefined);
  if (!lockIdentity?.ownerId) {
    // Owner IDs and targeted restart semantics shipped together. Older Gateways
    // ignore target fields, so fail before a candidate can mutate their state.
    fail(
      "Gateway restart failed: the active Gateway lock predates targeted restart ownership; update the running Gateway before retrying",
    );
    return false;
  }
  if (opts.safe) {
    return await runSafeGatewayRestart(opts, { ...lockIdentity, ownerId: lockIdentity.ownerId });
  }

  let signaled: Awaited<ReturnType<typeof signalGatewayRestart>>;
  try {
    signaled = await signalGatewayRestart(lockIdentity.port, {
      restartIntent,
      enforceRestartConfig: false,
      processLabel: "externally supervised",
      auditSource: "supervisor",
    });
  } catch (err) {
    fail(`Gateway restart failed: ${String(err)}`);
    return false;
  }
  if (!signaled) {
    fail(
      `No verified gateway process is listening on port ${lockIdentity.port}. ${formatExternalSupervisorActionRequired("start the gateway")}`,
    );
    return false;
  }

  const healthWait = resolveRestartListenerHealthWait(restartIntent);
  const health = await waitForGatewayHealthyListener({
    port: lockIdentity.port,
    attempts: healthWait.attempts,
    delayMs: POST_RESTART_HEALTH_DELAY_MS,
    previousLockIdentity: signaled.previousLockIdentity,
    waitIndefinitelyForPreviousOwner: healthWait.waitIndefinitelyForPreviousOwner,
  });
  if (!health.healthy) {
    const message = `Gateway restart timed out after ${healthWait.timeoutSeconds}s waiting for health checks.`;
    fail(message, renderGatewayPortHealthDiagnostics(health));
    return false;
  }

  emitMessage({
    ok: true,
    result: signaled.result,
    message: signaled.message,
  });
  return true;
}

/** Uninstall the managed Gateway service after stopping it. */
export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  assertGatewayServiceMutationAllowed("uninstall the gateway service");
  return await runServiceUninstall({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
}

/** Start the managed Gateway service, repairing stale service definitions when possible. */
export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  assertGatewayServiceMutationAllowed("start the gateway");
  const service = resolveGatewayService();
  const expectedPort = (await resolveGatewayConfigPorts()).explicit;
  return await runServiceStart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    onNotLoaded:
      process.platform === "darwin"
        ? async () => {
            const recovered = await recoverInstalledLaunchAgent({ result: "started" });
            if (recovered) {
              appendGatewayLifecycleAudit({
                action: "start",
                source: "cli",
                mode: "launchd-bootstrap",
              });
            }
            return recovered;
          }
        : undefined,
    repairLoadedService: async ({ json, stdout, warn, state, issues }) =>
      await repairLoadedGatewayServiceForStart({
        service,
        json,
        stdout,
        warn,
        state,
        issues,
      }),
    postStartCheck: ({ fail, warnings }) =>
      verifyGatewayStartReadiness({
        service,
        expectedPort,
        resolveContext: () => resolveGatewayLifecycleContext(service),
        fail,
        warnings,
      }),
    expectedPort,
    opts,
  });
}

/** Stop the managed Gateway service or verified unmanaged listener fallback. */
export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  if (!isTerminalInteractive() && !opts.force) {
    const { fail } = createDaemonActionContext({ action: "stop", json: Boolean(opts.json) });
    fail(NON_INTERACTIVE_GATEWAY_STOP_MESSAGE);
    return;
  }
  assertGatewayServiceUpdateCurrent();
  if (isGatewayExternallySupervised()) {
    assertGatewayServiceMutationAllowed("stop the gateway");
  }
  const service = resolveGatewayService();
  return await runServiceStop({
    serviceNoun: "Gateway",
    service,
    opts,
    beforeServiceMutation: () => assertGatewayServiceMutationAllowed("stop the gateway"),
    stopWhenNotLoaded: process.platform === "darwin" && Boolean(opts.disable),
    onNotLoaded: async ({ stdout }) => {
      if (process.platform === "linux") {
        const runtime = await service.readRuntime(process.env).catch(() => null);
        if (runtime?.status === "running") {
          // systemd can run a disabled unit with Restart=always. Stop it through
          // systemctl so a process-level SIGTERM cannot trigger a respawn.
          assertGatewayServiceMutationAllowed("stop the gateway");
          await service.stop({
            env: process.env,
            stdout,
            onMutation: createGatewayLifecycleMutationAudit({ action: "stop" }),
          });
          return { result: "stopped" };
        }
      }
      assertGatewayServiceFallbackAllowed("unmanaged stop");
      // An unmanaged run loop keeps its lock port across config edits, so use it
      // for discovery the way restart already does; otherwise a valid port
      // override makes the running gateway look like it is already stopped.
      const mutationError = resolveGatewayServiceMutationError("stop the gateway");
      const lock = mutationError
        ? await readActiveGatewayLockIdentity({ requireInspection: true })
        : await readActiveGatewayLockIdentity().catch(() => undefined);
      if (mutationError && !lock) {
        throw mutationError;
      }
      const ctx = lock ? null : await resolveGatewayLifecycleContext(service).catch(() => null);
      const port = lock?.port ?? ctx?.port ?? (await resolveGatewayConfigPorts()).fallback;
      const handled = await stopGatewayWithoutServiceManager(
        port,
        lock?.pid,
        ctx ?? undefined,
        mutationError ? lock : undefined,
      );
      if (!handled) {
        assertGatewayServiceMutationAllowed("stop the gateway");
      }
      return handled;
    },
  });
}

/** Restart the Gateway service or a verified unmanaged listener, then prove health. */
export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}): Promise<boolean> {
  const preserveDefinition = Boolean(opts.preserveDefinition);
  if (preserveDefinition) {
    assertGatewayServiceMutationAllowed("restart the gateway");
    if (opts.safe) {
      throw new Error("--preserve-definition requires a native restart without --safe");
    }
  }
  if (opts.skipDeferral && !opts.safe) {
    throw new Error("--skip-deferral requires --safe");
  }
  if (isGatewayExternallySupervised()) {
    assertGatewayServiceFallbackAllowed("external-supervisor restart");
    return await runExternalSupervisorRestart(opts);
  }
  if (opts.safe) {
    assertGatewayServiceFallbackAllowed("safe RPC restart");
    return await runSafeGatewayRestart(opts);
  }
  const jsonOutput = Boolean(opts.json);
  const service = resolveGatewayService();
  let restartedWithoutServiceManager = false;
  let unmanagedPreviousLockIdentity: GatewayLockIdentity | undefined;
  const restartIntent = resolveGatewayRestartIntentOptions(opts);
  const { explicit: configuredPort, fallback: fallbackPort } = await resolveGatewayConfigPorts();
  let managedRestartContext = await resolveGatewayLifecycleContext(
    service,
    preserveDefinition,
  ).catch(async (error: unknown) => {
    if (preserveDefinition) {
      throw error;
    }
    return { port: fallbackPort, env: process.env };
  });
  let managedRestartPort = preserveDefinition
    ? managedRestartContext.port
    : (configuredPort ?? managedRestartContext.port);
  // An unmanaged run loop keeps its lock port across in-process restarts, even
  // when config changes underneath it. Use that port for both the signal and
  // health proof or a valid CLI/env override looks like a failed restart.
  let unmanagedPort =
    (await readActiveGatewayLockPort().catch(() => undefined)) ?? managedRestartPort;
  const restartHealthAttempts = postRestartHealthAttempts();
  const restartWaitMs = restartHealthAttempts * POST_RESTART_HEALTH_DELAY_MS;
  const restartWaitSeconds = Math.round(restartWaitMs / 1000);
  let unmanagedRestartWait: ReturnType<typeof resolveRestartListenerHealthWait> | undefined;

  return await runServiceRestart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    opts: {
      ...opts,
      ...(restartIntent ? { restartIntent } : {}),
    },
    checkTokenDrift: true,
    expectedPort: configuredPort,
    beforeServiceMutation: () => assertGatewayServiceMutationAllowed("restart the gateway"),
    restartOwnedProcess: preserveDefinition
      ? undefined
      : async () => {
          const owner = readGatewayOwnerLease();
          if (!owner || owner.state === "dead" || owner.mode !== "foreground") {
            return null;
          }
          assertGatewayServiceFallbackAllowed("foreground owner restart");
          if (owner.state !== "live") {
            throw new Error(
              `Cannot verify foreground Gateway owner pid ${owner.pid} on ${owner.host}`,
            );
          }
          unmanagedPort = owner.port;
          const ready = await waitForGatewayHealthyListener({
            port: owner.port,
            env: process.env,
            attempts: restartHealthAttempts,
            delayMs: POST_RESTART_HEALTH_DELAY_MS,
          });
          if (!ready.healthy) {
            throw new Error(
              `Foreground Gateway owner pid ${owner.pid} is still starting or unhealthy on port ${owner.port}; it was left running`,
            );
          }
          const handled = await signalGatewayRestart(owner.port, {
            restartIntent,
            enforceRestartConfig: true,
            processLabel: "foreground",
            auditSource: "cli",
            ownerLease: owner,
            env: process.env,
          });
          if (!handled) {
            throw new Error(
              `Foreground Gateway owner pid ${owner.pid} no longer listens on port ${owner.port}`,
            );
          }
          restartedWithoutServiceManager = true;
          unmanagedPreviousLockIdentity = handled.previousLockIdentity;
          unmanagedRestartWait = resolveRestartListenerHealthWait(restartIntent);
          return handled;
        },
    repairLoadedService: preserveDefinition
      ? undefined
      : async ({ json, stdout, warn, state, issues }) => {
          const result = await repairLoadedGatewayServiceForStart({
            action: "restart",
            service,
            json,
            stdout,
            warn,
            state,
            issues,
          });
          // Repair rewrites the service definition, so the old command environment
          // no longer identifies where the restarted gateway publishes readiness.
          managedRestartContext = await resolveGatewayLifecycleContext(service);
          managedRestartPort = configuredPort ?? managedRestartContext.port;
          return result;
        },
    onNotLoaded: async () => {
      assertGatewayServiceFallbackAllowed("unmanaged restart");
      if (preserveDefinition) {
        return null;
      }
      const mutationError = resolveGatewayServiceMutationError("restart the gateway");
      if (process.platform === "darwin" && !mutationError) {
        const recovered = await recoverInstalledLaunchAgent({ result: "restarted" });
        if (recovered) {
          appendGatewayLifecycleAudit({
            action: "restart",
            source: "cli",
            mode: "launchd-bootstrap",
          });
          return recovered;
        }
      }
      const handled = await restartUnmanaged(unmanagedPort, restartIntent, !mutationError);
      if (handled) {
        restartedWithoutServiceManager = true;
        if (isGatewaySignalRestartResult(handled) && handled.previousLockIdentity) {
          unmanagedPreviousLockIdentity = handled.previousLockIdentity;
          unmanagedRestartWait = resolveRestartListenerHealthWait(restartIntent);
        }
        return handled;
      }
      if (mutationError) {
        throw mutationError;
      }
      return null;
    },
    postRestartCheck: async ({ warnings, fail, stdout, warn, activationAccepted: accepted }) => {
      let activationAccepted = accepted;
      if (restartedWithoutServiceManager) {
        // Unmanaged restarts have no service-manager state to watch; prove
        // listener health and replacement of the previous lock owner.
        const health = await waitForGatewayHealthyListener({
          port: unmanagedPort,
          env: process.env,
          attempts: unmanagedRestartWait?.attempts ?? restartHealthAttempts,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
          ...(unmanagedPreviousLockIdentity
            ? {
                previousLockIdentity: unmanagedPreviousLockIdentity,
                waitIndefinitelyForPreviousOwner:
                  unmanagedRestartWait?.waitIndefinitelyForPreviousOwner ?? false,
              }
            : {}),
        });
        if (health.healthy) {
          return undefined;
        }

        const diagnostics = renderGatewayPortHealthDiagnostics(health);
        const waitSeconds = unmanagedRestartWait?.timeoutSeconds ?? restartWaitSeconds;
        const timeoutLine = `Timed out after ${waitSeconds}s waiting for gateway port ${unmanagedPort} to become healthy.`;
        if (!jsonOutput) {
          defaultRuntime.log(theme.warn(timeoutLine));
          for (const line of diagnostics) {
            defaultRuntime.log(theme.muted(line));
          }
        } else {
          warnings.push(timeoutLine);
          warnings.push(...diagnostics);
        }

        fail(
          `Gateway restart timed out after ${waitSeconds}s waiting for health checks.`,
          [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")],
          activationAccepted ? "restart-health-failed" : undefined,
        );
        throw new Error("unreachable after gateway restart health failure");
      }

      const waitForHealthy = async () =>
        await waitForGatewayHealthyRestart({
          service,
          port: managedRestartPort,
          attempts: restartHealthAttempts,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
          env: managedRestartContext.env,
          ...(managedRestartContext.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1"
            ? { requirePluginHealth: false }
            : {}),
          supervisorKeepsAlive: process.platform === "darwin",
        });
      let health = await waitForHealthy();

      if (!health.healthy && health.staleGatewayPids.length > 0) {
        // On Windows service restarts can leave stale listeners behind; kill verified stale
        // Gateway pids once, restart again, then re-run the same health proof.
        const staleMsg = `Found stale gateway process(es): ${health.staleGatewayPids.join(", ")}.`;
        warnings.push(staleMsg);
        if (!jsonOutput) {
          defaultRuntime.log(theme.warn(staleMsg));
          defaultRuntime.log(theme.muted("Stopping stale process(es) and retrying restart..."));
        }

        const terminated = await terminateStaleGatewayPids(health.staleGatewayPids, {
          env: managedRestartContext.env,
          assertCurrent: assertGatewayServiceUpdateCurrent,
        });
        const currentOwner = readGatewayOwnerLease({ env: managedRestartContext.env });
        if (terminated.length > 0 && (!currentOwner || currentOwner.state === "dead")) {
          const retryRestart = await service.restart({
            preserveDefinition,
            env: process.env,
            stdout,
            warn,
            onMutation: createGatewayLifecycleMutationAudit({ action: "restart" }),
          });
          if (retryRestart.outcome === "scheduled") {
            return retryRestart;
          }
          activationAccepted = true;
        }
        health = await waitForHealthy();
      }

      if (health.healthy) {
        return undefined;
      }

      const diagnostics = renderRestartDiagnostics(health);
      const failure = formatGatewayRestartFailure({
        health,
        port: managedRestartPort,
        defaultTimeoutSeconds: restartWaitSeconds,
      });
      const runningNoPortLine =
        health.waitOutcome !== "still-starting" &&
        health.runtime.status === "running" &&
        health.portUsage.status === "free"
          ? `Gateway process is running but port ${managedRestartPort} is still free (startup hang/crash loop or very slow VM startup).`
          : null;
      if (!jsonOutput) {
        defaultRuntime.log(theme.warn(failure.statusLine));
        if (runningNoPortLine) {
          defaultRuntime.log(theme.warn(runningNoPortLine));
        }
        for (const line of diagnostics) {
          defaultRuntime.log(theme.muted(line));
        }
      } else {
        warnings.push(failure.statusLine);
        if (runningNoPortLine) {
          warnings.push(runningNoPortLine);
        }
        warnings.push(...diagnostics);
      }

      fail(
        failure.failMessage,
        [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")],
        health.waitOutcome === "still-starting"
          ? // Published updater parents recognize this envelope and continue readiness verification.
            managedRestartContext.env.OPENCLAW_UPDATE_IN_PROGRESS === "1"
            ? "restart-health-failed"
            : "still-starting"
          : activationAccepted
            ? "restart-health-failed"
            : undefined,
      );
      throw new Error("unreachable after gateway restart failure");
    },
  });
}
