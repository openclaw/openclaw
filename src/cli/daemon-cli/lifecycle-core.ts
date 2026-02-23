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
    emit({
      ok: true,
      result: "not-loaded",
      message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
      service: buildDaemonServiceSnapshot(params.service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
    }
    return;
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
  if (!loaded) {
    await handleServiceNotLoaded({
      serviceNoun: params.serviceNoun,
      service: params.service,
      loaded,
      renderStartHints: params.renderStartHints,
      json,
      emit,
    });
    return false;
  }

  // Hoist config load — used for restart-enabled check, token drift, and credential resolution.
  const warnings: string[] = [];

  let cfg: OpenClawConfig;
  try {
    cfg = loadConfig();
  } catch (cfgErr) {
    if (!json) {
      defaultRuntime.log(
        `\nℹ️  Config load failed — falling back to service restart. (${String(cfgErr)})\n`,
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

  // --hard: bypass graceful path entirely. isRestartEnabled is NOT checked here.
  // ORDERING IS LOAD-BEARING: this check MUST remain before isRestartEnabled().
  if (params.opts?.hard) {
    if (!json) {
      defaultRuntime.log(
        "\n⚠️  Hard restart requested — using systemctl (kills process, no task drain).\n",
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
        "Use --hard to force a service restart via systemctl (bypasses this setting).",
      ],
    });
    if (!json) {
      defaultRuntime.log("\n❌ Gateway restart is disabled (commands.restart=false).");
      defaultRuntime.log("   Use --hard to force a service restart via systemctl.\n");
    }
    return false;
  }

  // TODO(remove-migration-notice): Remove this block after 2 releases.
  // Track: openclaw/openclaw#24121
  const migrationNotice =
    "`openclaw gateway restart` now defaults to graceful restart (SIGUSR1). " +
    "For the old behaviour (systemctl kill + respawn), use --hard. " +
    "This notice will be removed after the next release.";
  if (!json) {
    defaultRuntime.log(`ℹ️  ${migrationNotice}`);
  }

  // Resolve gateway PID and send SIGUSR1 directly.
  const pid = await resolveGatewayPid(params.service);
  if (pid === null) {
    if (!json) {
      defaultRuntime.log(
        "\nℹ️  Could not resolve gateway PID — falling back to service restart.\n",
      );
    }
    return runHardServiceRestart({ params, json, stdout, emit, fail, warnings });
  }

  try {
    process.kill(pid, "SIGUSR1");
  } catch (err) {
    if (!json) {
      defaultRuntime.log(
        `\nℹ️  SIGUSR1 delivery failed — falling back to service restart. (${String(err)})\n`,
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
      notice: migrationNotice,
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(`⚠️  Restart signal sent but health check could not be set up: ${errMsg}`);
    }
    return true;
  }

  // 45s budget: covers up to 30s task drain + gateway respawn + WS reconnect.
  // postRestartCheck is intentionally NOT called on the graceful path.
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
    notice: migrationNotice,
    warnings: warnings.length ? warnings : undefined,
  });
  if (!json) {
    defaultRuntime.log(
      healthy
        ? "✅ Gateway restarted successfully."
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
