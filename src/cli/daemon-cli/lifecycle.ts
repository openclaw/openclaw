import { isRestartEnabled } from "../../config/commands.js";
import { deferGatewayRestartUntilIdle } from "../../infra/restart";
import { writeRestartSentinel, type RestartSentinelPayload } from "../../infra/restart-sentinel";
import { deferGatewayRestartUntilIdle } from "../../infra/restart";
import { writeRestartSentinel, type RestartSentinelPayload } from "../../infra/restart-sentinel";
import { readBestEffortConfig, resolveGatewayPort } from "../../config/config.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList,
  signalVerifiedGatewayPidSync,
} from "../../infra/gateway-processes.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { formatCliCommand } from "../command-format.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "./lifecycle-core.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
  renderGatewayPortHealthDiagnostics,
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyListener,
  waitForGatewayHealthyRestart,
} from "./restart-health.js";
import { parsePortFromArgs, renderGatewayServiceStartHints } from "./shared.js";
import type { DaemonLifecycleOptions } from "./types.js";

const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = DEFAULT_RESTART_HEALTH_DELAY_MS;

async function resolveGatewayLifecyclePort(service = resolveGatewayService()) {
  const command = await service.readCommand(process.env).catch(() => null);
  const serviceEnv = command?.environment ?? undefined;
  const mergedEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(serviceEnv ?? undefined),
  } as NodeJS.ProcessEnv;

  const portFromArgs = parsePortFromArgs(command?.programArguments);
  return portFromArgs ?? resolveGatewayPort(await readBestEffortConfig(), mergedEnv);
}

function resolveGatewayPortFallback(): Promise<number> {
  return readBestEffortConfig()
    .then((cfg) => resolveGatewayPort(cfg, process.env))
    .catch(() => resolveGatewayPort(undefined, process.env));
}

async function assertUnmanagedGatewayRestartEnabled(port: number): Promise<void> {
  const cfg = await readBestEffortConfig().catch(() => undefined);
  const tlsEnabled = !!cfg?.gateway?.tls?.enabled;
  const scheme = tlsEnabled ? "wss" : "ws";
  const probe = await probeGateway({
    url: `${scheme}://127.0.0.1:${port}`,
    auth: {
      token: process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || undefined,
      password: process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || undefined,
    },
    timeoutMs: 1_000,
  }).catch(() => null);

  if (!probe?.ok) {
    return;
  }
  if (!isRestartEnabled(probe.configSnapshot as { commands?: unknown } | undefined)) {
    throw new Error(
      "Gateway restart is disabled in the running gateway config (commands.restart=false); unmanaged SIGUSR1 restart would be ignored",
    );
  }
}

function resolveVerifiedGatewayListenerPids(port: number): number[] {
  return findVerifiedGatewayListenerPidsOnPortSync(port).filter(
    (pid): pid is number => Number.isFinite(pid) && pid > 0,
  );
}

async function stopGatewayWithoutServiceManager(port: number) {
  const pids = resolveVerifiedGatewayListenerPids(port);
  if (pids.length === 0) {
    return null;
  }
  for (const pid of pids) {
    signalVerifiedGatewayPidSync(pid, "SIGTERM");
  }
  return {
    result: "stopped" as const,
    message: `Gateway stop signal sent to unmanaged process${pids.length === 1 ? "" : "es"} on port ${port}: ${formatGatewayPidList(pids)}.`,
  };
}

async function restartGatewayWithoutServiceManager(port: number) {
  await assertUnmanagedGatewayRestartEnabled(port);
  const pids = resolveVerifiedGatewayListenerPids(port);
  if (pids.length === 0) {
    return null;
  }
  if (pids.length > 1) {
    throw new Error(
      `multiple gateway processes are listening on port ${port}: ${formatGatewayPidList(pids)}; use "openclaw gateway status --deep" before retrying restart`,
    );
  }
  signalVerifiedGatewayPidSync(pids[0], "SIGUSR1");
  return {
    result: "restarted" as const,
    message: `Gateway restart signal sent to unmanaged process on port ${port}: ${pids[0]}.`,
  };
}

export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  return await runServiceUninstall({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
}

export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}): Promise<boolean> {
  const json = Boolean(opts.json);
  const service = resolveGatewayService();
  let restartedWithoutServiceManager = false;
  const restartPort = await resolveGatewayLifecyclePort(service).catch(() => resolveGatewayPortFallback());
  const restartWaitMs = POST_RESTART_HEALTH_ATTEMPTS * POST_RESTART_HEALTH_DELAY_MS;
  const restartWaitSeconds = Math.round(restartWaitMs / 1000);

  // Windows graceful restart
  if (process.platform === 'win32') {
    try {
      defaultRuntime.log(theme.info("Waiting for active tasks to complete before restart..."));
      await deferGatewayRestartUntilIdle({
        getPendingCount: async () => { return 0; },
        maxWaitMs: 300000,
        pollMs: 1000
      });

      defaultRuntime.log(theme.info("Writing restart sentinel for session recovery..."));
      const sentinelPayload: RestartSentinelPayload = {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        reason: "manual restart",
        sessionKey: opts.sessionKey
      };
      await writeRestartSentinel(sentinelPayload);

      defaultRuntime.log(theme.info("Stopping Gateway gracefully..."));
      await runServiceStop({
        serviceNoun: "Gateway",
        service,
        opts,
        onNotLoaded: async () => stopGatewayWithoutServiceManager(restartPort)
      });

      defaultRuntime.log(theme.info("Starting Gateway..."));
      await runServiceStart({
        serviceNoun: "Gateway",
        service,
        renderStartHints: renderGatewayServiceStartHints,
        opts
      });

      defaultRuntime.log(theme.info("Waiting for Gateway to become healthy..."));
      const health = await waitForGatewayHealthyRestart({
        service,
        port: restartPort,
        attempts: POST_RESTART_HEALTH_ATTEMPTS,
        delayMs: POST_RESTART_HEALTH_DELAY_MS,
        includeUnknownListenersAsStale: true
      });

      if (!health.healthy) {
        const diagnostics = renderRestartDiagnostics(health);
        const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
        if (!json) {
          defaultRuntime.log(theme.warn(timeoutLine));
          for (const line of diagnostics) defaultRuntime.log(theme.muted(line));
        } else {
          warnings.push(timeoutLine);
          warnings.push(...diagnostics);
        }
        fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [
          formatCliCommand("openclaw gateway status --deep"),
          formatCliCommand("openclaw doctor")
        ]);
      }

      defaultRuntime.log(theme.success("Gateway restarted gracefully with session recovery!"));
      return true;
    } catch (err) {
      defaultRuntime.log(theme.warn(`Graceful restart failed: ${String(err)}. Falling back to standard restart.`));
    }
  }

  return await runServiceRestart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    opts,
    checkTokenDrift: true,
    onNotLoaded: async () => {
      const handled = await restartGatewayWithoutServiceManager(restartPort);
      if (handled) restartedWithoutServiceManager = true;
      return handled;
    },
    postRestartCheck: async ({ warnings, fail, stdout }) => {
      if (restartedWithoutServiceManager) {
        const health = await waitForGatewayHealthyListener({
          port: restartPort,
          attempts: POST_RESTART_HEALTH_ATTEMPTS,
          delayMs: POST_RESTART_HEALTH_DELAY_MS
        });
        if (health.healthy) return;

        const diagnostics = renderGatewayPortHealthDiagnostics(health);
        const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
        if (!json) {
          defaultRuntime.log(theme.warn(timeoutLine));
          for (const line of diagnostics) defaultRuntime.log(theme.muted(line));
        } else {
          warnings.push(timeoutLine);
          warnings.push(...diagnostics);
        }
        fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [
          formatCliCommand("openclaw gateway status --deep"),
          formatCliCommand("openclaw doctor")
        ]);
      }

      let health = await waitForGatewayHealthyRestart({
        service,
        port: restartPort,
        attempts: POST_RESTART_HEALTH_ATTEMPTS,
        delayMs: POST_RESTART_HEALTH_DELAY_MS,
        includeUnknownListenersAsStale: process.platform === "win32"
      });

      if (!health.healthy && health.staleGatewayPids.length > 0) {
        const staleMsg = `Found stale gateway process(es): ${health.staleGatewayPids.join(", ")}.`;
        warnings.push(staleMsg);
        if (!json) {
          defaultRuntime.log(theme.warn(staleMsg));
          defaultRuntime.log(theme.muted("Stopping stale process(es) and retrying restart..."));
        }
        await terminateStaleGatewayPids(health.staleGatewayPids);
        const retryRestart = await service.restart({ env: process.env, stdout });
        if (retryRestart.outcome === "scheduled") return retryRestart;
        health = await waitForGatewayHealthyRestart({
          service,
          port: restartPort,
          attempts: POST_RESTART_HEALTH_ATTEMPTS,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
          includeUnknownListenersAsStale: process.platform === "win32"
        });
      }

      if (health.healthy) return;

      const diagnostics = renderRestartDiagnostics(health);
      const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
      const runningNoPortLine = health.runtime.status === "running" && health.portUsage.status === "free"
        ? `Gateway process is running but port ${restartPort} is still free (startup hang/crash loop or very slow VM startup).`
        : null;
      if (!json) {
        defaultRuntime.log(theme.warn(timeoutLine));
        if (runningNoPortLine) defaultRuntime.log(theme.warn(runningNoPortLine));
        for (const line of diagnostics) defaultRuntime.log(theme.muted(line));
      } else {
        warnings.push(timeoutLine);
        if (runningNoPortLine) warnings.push(runningNoPortLine);
        warnings.push(...diagnostics);
      }

      fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [
        formatCliCommand("openclaw gateway status --deep"),
        formatCliCommand("openclaw doctor")
      ]);
    }
  });
}


export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  return await runServiceStart({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    renderStartHints: renderGatewayServiceStartHints,
    opts,
  });
}

export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  const service = resolveGatewayService();
  const gatewayPort = await resolveGatewayLifecyclePort(service).catch(() =>
    resolveGatewayPortFallback(),
  );
  return await runServiceStop({
    serviceNoun: "Gateway",
    service,
    opts,
    onNotLoaded: async () => stopGatewayWithoutServiceManager(gatewayPort),
  });
}

/**
 * Restart the gateway service service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
;
}

}

): Promise<boolean> {
  const json = Boolean(opts.json);
  const service = resolveGatewayService();
  let restartedWithoutServiceManager = false;
  const restartPort = await resolveGatewayLifecyclePort(service).catch(() =>
    resolveGatewayPortFallback(),
  );
  const restartWaitMs = POST_RESTART_HEALTH_ATTEMPTS * POST_RESTART_HEALTH_DELAY_MS;
  const restartWaitSeconds = Math.round(restartWaitMs / 1000);

  return await runServiceRestart({
    serviceNoun: "Gateway",
    service,
    renderStartHints: renderGatewayServiceStartHints,
    opts,
    checkTokenDrift: true,
    onNotLoaded: async () => {
      const handled = await restartGatewayWithoutServiceManager(restartPort);
      if (handled) {
        restartedWithoutServiceManager = true;
      }
      return handled;
    },
    postRestartCheck: async ({ warnings, fail, stdout }) => {
      if (restartedWithoutServiceManager) {
        const health = await waitForGatewayHealthyListener({
          port: restartPort,
          attempts: POST_RESTART_HEALTH_ATTEMPTS,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
        });
        if (health.healthy) {
          return;
        }

        const diagnostics = renderGatewayPortHealthDiagnostics(health);
        const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
        if (!json) {
          defaultRuntime.log(theme.warn(timeoutLine));
          for (const line of diagnostics) {
            defaultRuntime.log(theme.muted(line));
          }
        } else {
          warnings.push(timeoutLine);
          warnings.push(...diagnostics);
        }

        fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [
          formatCliCommand("openclaw gateway status --deep"),
          formatCliCommand("openclaw doctor"),
        ]);
      }

      let health = await waitForGatewayHealthyRestart({
        service,
        port: restartPort,
        attempts: POST_RESTART_HEALTH_ATTEMPTS,
        delayMs: POST_RESTART_HEALTH_DELAY_MS,
        includeUnknownListenersAsStale: process.platform === "win32",
      });

      if (!health.healthy && health.staleGatewayPids.length > 0) {
        const staleMsg = `Found stale gateway process(es): ${health.staleGatewayPids.join(", ")}.`;
        warnings.push(staleMsg);
        if (!json) {
          defaultRuntime.log(theme.warn(staleMsg));
          defaultRuntime.log(theme.muted("Stopping stale process(es) and retrying restart..."));
        }

        await terminateStaleGatewayPids(health.staleGatewayPids);
        const retryRestart = await service.restart({ env: process.env, stdout });
        if (retryRestart.outcome === "scheduled") {
          return retryRestart;
        }
        health = await waitForGatewayHealthyRestart({
          service,
          port: restartPort,
          attempts: POST_RESTART_HEALTH_ATTEMPTS,
          delayMs: POST_RESTART_HEALTH_DELAY_MS,
          includeUnknownListenersAsStale: process.platform === "win32",
        });
      }

      if (health.healthy) {
        return;
      }

      const diagnostics = renderRestartDiagnostics(health);
      const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
      const runningNoPortLine =
        health.runtime.status === "running" && health.portUsage.status === "free"
          ? `Gateway process is running but port ${restartPort} is still free (startup hang/crash loop or very slow VM startup).`
          : null;
      if (!json) {
        defaultRuntime.log(theme.warn(timeoutLine));
        if (runningNoPortLine) {
          defaultRuntime.log(theme.warn(runningNoPortLine));
        }
        for (const line of diagnostics) {
          defaultRuntime.log(theme.muted(line));
        }
      } else {
        warnings.push(timeoutLine);
        if (runningNoPortLine) {
          warnings.push(runningNoPortLine);
        }
        warnings.push(...diagnostics);
      }

      fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [
        formatCliCommand("openclaw gateway status --deep"),
        formatCliCommand("openclaw doctor"),
      ]);
    },
  });
}


