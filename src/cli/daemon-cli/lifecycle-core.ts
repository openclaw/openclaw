import type { Writable } from "node:stream";
import { isRestartEnabled } from "../../config/commands.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { checkTokenDrift } from "../../daemon/service-audit.js";
import type { GatewayService } from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { buildGatewayConnectionDetails } from "../../gateway/call.js";
import { resolveGatewayCredentialsFromConfig } from "../../gateway/credentials.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";
import {
  buildDaemonServiceSnapshot,
  createNullWriter,
  type DaemonAction,
  type DaemonActionResponse,
  emitDaemonActionJson,
} from "./response.js";
import { resolveGatewayPid, pollUntilGatewayHealthy } from "./sigusr1-restart.js";
import type { DaemonLifecycleOptions } from "./types.js";

type RestartPostCheckContext = {
  json: boolean;
  stdout: Writable;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

async function maybeAugmentSystemdHints(hints: string[]): Promise<string[]> {
  if (process.platform !== "linux") {
    return hints;
  }
  const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
  if (systemdAvailable) {
    return hints;
  }
  return [...hints, ...renderSystemdUnavailableHints({ wsl: await isWSL() })];
}

function createActionIO(params: { action: DaemonAction; json: boolean }) {
  const stdout = params.json ? createNullWriter() : process.stdout;
  const emit = (payload: Omit<DaemonActionResponse, "action">) => {
    if (!params.json) {
      return;
    }
    emitDaemonActionJson({ action: params.action, ...payload });
  };
  const fail = (message: string, hints?: string[]) => {
    if (params.json) {
      emit({ ok: false, error: message, hints });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
  };
  return { stdout, emit, fail };
}

async function handleServiceNotLoaded(params: {
  serviceNoun: string;
  service: GatewayService;
  loaded: boolean;
  renderStartHints: () => string[];
  json: boolean;
  emit: ReturnType<typeof createActionIO>["emit"];
}) {
  const hints = await maybeAugmentSystemdHints(params.renderStartHints());
  params.emit({
    ok: true,
    result: "not-loaded",
    message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
    hints,
    service: buildDaemonServiceSnapshot(params.service, params.loaded),
  });
  if (!params.json) {
    defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
    for (const hint of hints) {
      defaultRuntime.log(`Start with: ${hint}`);
    }
  }
}

async function resolveServiceLoadedOrFail(params: {
  serviceNoun: string;
  service: GatewayService;
  fail: ReturnType<typeof createActionIO>["fail"];
}): Promise<boolean | null> {
  try {
    return await params.service.isLoaded({ env: process.env });
  } catch (err) {
    params.fail(`${params.serviceNoun} service check failed: ${String(err)}`);
    return null;
  }
}

export async function runServiceUninstall(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: DaemonLifecycleOptions;
  stopBeforeUninstall: boolean;
  assertNotLoadedAfterUninstall: boolean;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createActionIO({ action: "uninstall", json });

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service uninstall is disabled.");
    return;
  }

  let loaded = false;
  try {
    loaded = await params.service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (loaded && params.stopBeforeUninstall) {
    try {
      await params.service.stop({ env: process.env, stdout });
    } catch {
      // Best-effort stop; final loaded check gates success when enabled.
    }
  }
  try {
    await params.service.uninstall({ env: process.env, stdout });
  } catch (err) {
    fail(`${params.serviceNoun} uninstall failed: ${String(err)}`);
    return;
  }

  loaded = false;
  try {
    loaded = await params.service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (loaded && params.assertNotLoadedAfterUninstall) {
    fail(`${params.serviceNoun} service still loaded after uninstall.`);
    return;
  }
  emit({
    ok: true,
    result: "uninstalled",
    service: buildDaemonServiceSnapshot(params.service, loaded),
  });
}

export async function runServiceStart(params: {
  serviceNoun: string;
  service: GatewayService;
  renderStartHints: () => string[];
  opts?: DaemonLifecycleOptions;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createActionIO({ action: "start", json });

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });
  if (loaded === null) {
    return;
  }
  if (!loaded) {
    await handleServiceNotLoaded({
      serviceNoun: params.serviceNoun,
      service: params.service,
      loaded,
      renderStartHints: params.renderStartHints,
      json,
      emit,
    });
    return;
  }
  try {
    await params.service.restart({ env: process.env, stdout });
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
    return;
  }

  let started = true;
  try {
    started = await params.service.isLoaded({ env: process.env });
  } catch {
    started = true;
  }
  emit({
    ok: true,
    result: "started",
    service: buildDaemonServiceSnapshot(params.service, started),
  });
}

export async function runServiceStop(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: DaemonLifecycleOptions;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createActionIO({ action: "stop", json });

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });
  if (loaded === null) {
    return;
  }
  if (!loaded) {
    // No service manager — try direct signal stop via port-based PID discovery.
    return runDirectSignalStop({ params, json, emit });
  }
  try {
    await params.service.stop({ env: process.env, stdout });
  } catch (err) {
    fail(`${params.serviceNoun} stop failed: ${String(err)}`);
    return;
  }

  let stopped = false;
  try {
    stopped = await params.service.isLoaded({ env: process.env });
  } catch {
    stopped = false;
  }
  emit({
    ok: true,
    result: "stopped",
    service: buildDaemonServiceSnapshot(params.service, stopped),
  });
}

export async function runServiceRestart(params: {
  serviceNoun: string;
  service: GatewayService;
  renderStartHints: () => string[];
  opts?: DaemonLifecycleOptions;
  checkTokenDrift?: boolean;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
}): Promise<boolean> {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createActionIO({ action: "restart", json });

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });
  if (loaded === null) {
    return false;
  }

  // When service manager is not available (container/foreground), try SIGUSR1 directly.
  // The gateway process handles SIGUSR1 natively for in-process restarts.
  if (!loaded) {
    if (params.opts?.hard) {
      if (!json) {
        defaultRuntime.log(
          "⚠️  --hard requires a service manager (systemd/launchd) which is not available.",
        );
        defaultRuntime.log("   Falling back to graceful SIGUSR1 restart.\n");
      }
    }
    return runDirectSigusr1Restart({ params, json, emit });
  }

  // Hoist config load — used for restart-enabled check, token drift, and credential resolution.
  const warnings: string[] = [];

  let cfg: OpenClawConfig;
  try {
    cfg = loadConfig();
  } catch (cfgErr) {
    if (!json) {
      defaultRuntime.log(
        `\nConfig load failed — falling back to service restart. (${String(cfgErr)})\n`,
      );
    }
    return runHardServiceRestart({ params, json, stdout, emit, fail, warnings });
  }

  // Token drift check: runs before any restart attempt (both graceful and hard paths).
  if (params.checkTokenDrift) {
    try {
      const command = await params.service.readCommand(process.env);
      const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN;
      const configToken = resolveGatewayCredentialsFromConfig({
        cfg,
        env: process.env,
        modeOverride: "local",
      }).token;
      const driftIssue = checkTokenDrift({ serviceToken, configToken });
      if (driftIssue) {
        warnings.push(
          driftIssue.detail ? `${driftIssue.message} ${driftIssue.detail}` : driftIssue.message,
        );
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${driftIssue.message}`);
          if (driftIssue.detail) {
            defaultRuntime.log(`   ${driftIssue.detail}\n`);
          }
        }
      }
    } catch {
      // Non-fatal: best-effort
    }
  }

  // --hard: bypass graceful path entirely.
  if (params.opts?.hard) {
    if (!json) {
      defaultRuntime.log(
        "\n⚠️  Hard restart requested — using service manager (kills process, no task drain).\n",
      );
    }
    return runHardServiceRestart({ params, json, stdout, emit, fail, warnings });
  }

  // Check restart is enabled before sending signal.
  if (!isRestartEnabled(cfg)) {
    emit({
      ok: false,
      error: "Gateway restart is disabled (commands.restart=false).",
      hints: [
        "Set commands.restart=true in your config to re-enable.",
        "Use --hard to force a service restart via the service manager (bypasses this setting).",
      ],
    });
    if (!json) {
      defaultRuntime.log("\nGateway restart is disabled (commands.restart=false).");
      defaultRuntime.log("   Use --hard to force a service restart via the service manager.\n");
    }
    return false;
  }

  // Resolve gateway PID and send SIGUSR1 directly.
  const pid = await resolveGatewayPid(params.service);
  if (pid === null) {
    if (!json) {
      defaultRuntime.log("\nCould not resolve gateway PID — falling back to service restart.\n");
    }
    return runHardServiceRestart({ params, json, stdout, emit, fail, warnings });
  }

  try {
    process.kill(pid, "SIGUSR1");
  } catch (err) {
    if (!json) {
      defaultRuntime.log(
        `\nSIGUSR1 delivery failed — falling back to service restart. (${String(err)})\n`,
      );
    }
    return runHardServiceRestart({ params, json, stdout, emit, fail, warnings });
  }

  // SIGUSR1 sent — restart is in motion. No more hard-restart fallback (would double-restart).
  let gatewayUrl: string;
  let gatewayToken: string | undefined;
  let gatewayPassword: string | undefined;

  try {
    const connectionDetails = buildGatewayConnectionDetails({ config: cfg });
    gatewayUrl = connectionDetails.url;

    const auth = resolveGatewayCredentialsFromConfig({ cfg });
    gatewayToken = auth.token;
    gatewayPassword = auth.password;
  } catch (setupErr) {
    const errMsg = String(setupErr);
    emit({
      ok: true,
      result: "restarted-unverified",
      message: `Restart signal sent; health check setup failed: ${errMsg}`,
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(`⚠️  Restart signal sent but health check could not be set up: ${errMsg}`);
    }
    return true;
  }

  const healthy = await pollUntilGatewayHealthy({
    url: gatewayUrl,
    token: gatewayToken,
    password: gatewayPassword,
    timeoutMs: 45_000,
  });

  emit({
    ok: true,
    result: healthy ? "restarted" : "restarted-unverified",
    message: healthy
      ? "Gateway restarted (graceful)."
      : "Restart signal sent; health check timed out.",
    warnings: warnings.length ? warnings : undefined,
  });
  if (!json) {
    defaultRuntime.log(
      healthy
        ? "Gateway restarted successfully."
        : "⚠️  Restart signal sent but gateway did not confirm healthy within timeout.",
    );
  }
  return true;
}

type HardRestartCtx = {
  params: {
    serviceNoun: string;
    service: GatewayService;
    renderStartHints: () => string[];
    opts?: DaemonLifecycleOptions;
    checkTokenDrift?: boolean;
    postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
  };
  json: boolean;
  stdout: Writable;
  emit: ReturnType<typeof createActionIO>["emit"];
  fail: ReturnType<typeof createActionIO>["fail"];
  warnings: string[];
};

async function runHardServiceRestart(ctx: HardRestartCtx): Promise<boolean> {
  try {
    await ctx.params.service.restart({ env: process.env, stdout: ctx.stdout });
    if (ctx.params.postRestartCheck) {
      await ctx.params.postRestartCheck({
        json: ctx.json,
        stdout: ctx.stdout,
        warnings: ctx.warnings,
        fail: ctx.fail,
      });
    }
    let restarted = true;
    try {
      restarted = await ctx.params.service.isLoaded({ env: process.env });
    } catch {
      restarted = true;
    }
    ctx.emit({
      ok: true,
      result: "restarted",
      service: buildDaemonServiceSnapshot(ctx.params.service, restarted),
      warnings: ctx.warnings.length ? ctx.warnings : undefined,
    });
    return true;
  } catch (err) {
    const hints = ctx.params.renderStartHints();
    ctx.fail(`${ctx.params.serviceNoun} restart failed: ${String(err)}`, hints);
    return false;
  }
}

/**
 * Direct SIGUSR1 restart for environments without a service manager (containers, foreground).
 * Discovers the gateway PID via port binding and sends SIGUSR1 directly.
 */
async function runDirectSigusr1Restart(ctx: {
  params: {
    serviceNoun: string;
    service: GatewayService;
    renderStartHints: () => string[];
    opts?: DaemonLifecycleOptions;
  };
  json: boolean;
  emit: ReturnType<typeof createActionIO>["emit"];
}): Promise<boolean> {
  const pid = await resolveGatewayPid(ctx.params.service);
  if (pid === null) {
    await handleServiceNotLoaded({
      serviceNoun: ctx.params.serviceNoun,
      service: ctx.params.service,
      loaded: false,
      renderStartHints: ctx.params.renderStartHints,
      json: ctx.json,
      emit: ctx.emit,
    });
    return false;
  }

  let cfg: OpenClawConfig | undefined;
  try {
    cfg = loadConfig();
  } catch {
    // Config unavailable — proceed without restart-enabled check and health poll.
  }

  if (cfg && !isRestartEnabled(cfg)) {
    ctx.emit({
      ok: false,
      error: "Gateway restart is disabled (commands.restart=false).",
    });
    if (!ctx.json) {
      defaultRuntime.log("\nGateway restart is disabled (commands.restart=false).\n");
    }
    return false;
  }

  try {
    process.kill(pid, "SIGUSR1");
  } catch (err) {
    ctx.emit({
      ok: false,
      error: `Failed to send restart signal to gateway (PID ${pid}): ${String(err)}`,
    });
    if (!ctx.json) {
      defaultRuntime.log(`Failed to send restart signal to gateway (PID ${pid}): ${String(err)}`);
    }
    return false;
  }

  if (!ctx.json) {
    defaultRuntime.log(`Restart signal sent to gateway (PID ${pid}).`);
  }

  // Health poll: verify the restart completed.
  if (cfg) {
    try {
      const connectionDetails = buildGatewayConnectionDetails({ config: cfg });
      const auth = resolveGatewayCredentialsFromConfig({ cfg });

      const healthy = await pollUntilGatewayHealthy({
        url: connectionDetails.url,
        token: auth.token,
        password: auth.password,
        timeoutMs: 45_000,
      });

      ctx.emit({
        ok: true,
        result: healthy ? "restarted" : "restarted-unverified",
        message: healthy
          ? "Gateway restarted (graceful)."
          : "Restart signal sent; health check timed out.",
      });
      if (!ctx.json) {
        defaultRuntime.log(
          healthy
            ? "Gateway restarted successfully."
            : "⚠️  Restart signal sent but gateway did not confirm healthy within timeout.",
        );
      }
      return true;
    } catch {
      // Health poll setup failed — signal was already sent.
    }
  }

  ctx.emit({
    ok: true,
    result: "restarted-unverified",
    message: "Restart signal sent; health check not available.",
  });
  return true;
}

/**
 * Direct signal stop for environments without a service manager (containers, foreground).
 * Discovers the gateway PID via port binding and sends SIGTERM directly.
 */
async function runDirectSignalStop(ctx: {
  params: {
    serviceNoun: string;
    service: GatewayService;
    opts?: DaemonLifecycleOptions;
  };
  json: boolean;
  emit: ReturnType<typeof createActionIO>["emit"];
}): Promise<void> {
  const pid = await resolveGatewayPid(ctx.params.service);
  if (pid === null) {
    ctx.emit({
      ok: true,
      result: "not-loaded",
      message: `${ctx.params.serviceNoun} is not running.`,
    });
    if (!ctx.json) {
      defaultRuntime.log(`${ctx.params.serviceNoun} is not running.`);
    }
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    ctx.emit({
      ok: false,
      error: `Failed to stop gateway (PID ${pid}): ${String(err)}`,
    });
    if (!ctx.json) {
      defaultRuntime.log(`Failed to stop gateway (PID ${pid}): ${String(err)}`);
    }
    return;
  }

  ctx.emit({
    ok: true,
    result: "stopped",
    message: `${ctx.params.serviceNoun} stopped (PID ${pid}).`,
  });
  if (!ctx.json) {
    defaultRuntime.log(`${ctx.params.serviceNoun} stopped (PID ${pid}).`);
  }
}
