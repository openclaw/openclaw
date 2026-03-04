import type { Writable } from "node:stream";
import { loadConfig } from "../../config/config.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { checkTokenDrift } from "../../daemon/service-audit.js";
import type { GatewayServiceEnv } from "../../daemon/service-types.js";
import type { GatewayService } from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdSystemScope } from "../../daemon/systemd-scope.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
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

type DaemonLifecycleOptions = {
  json?: boolean;
  env?: GatewayServiceEnv;
};

type RestartPostCheckContext = {
  json: boolean;
  stdout: Writable;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

async function maybeAugmentSystemdHints(
  hints: string[],
  env: GatewayServiceEnv,
): Promise<string[]> {
  if (process.platform !== "linux") {
    return hints;
  }
  if (isSystemdSystemScope(env)) {
    return hints;
  }
  const systemdAvailable = await isSystemdUserServiceAvailable(env).catch(() => false);
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
  env: GatewayServiceEnv;
}) {
  const hints = await maybeAugmentSystemdHints(params.renderStartHints(), params.env);
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
  env: GatewayServiceEnv;
}): Promise<boolean | null> {
  try {
    return await params.service.isLoaded({ env: params.env });
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
  env?: GatewayServiceEnv;
}) {
  const json = Boolean(params.opts?.json);
  const env = params.env ?? params.opts?.env ?? (process.env as GatewayServiceEnv);
  const { stdout, emit, fail } = createActionIO({ action: "uninstall", json });

  if (resolveIsNixMode(env as NodeJS.ProcessEnv)) {
    fail("Nix mode detected; service uninstall is disabled.");
    return;
  }

  let loaded = false;
  try {
    loaded = await params.service.isLoaded({ env });
  } catch {
    loaded = false;
  }
  if (loaded && params.stopBeforeUninstall) {
    try {
      await params.service.stop({ env, stdout });
    } catch {
      // Best-effort stop; final loaded check gates success when enabled.
    }
  }
  try {
    await params.service.uninstall({ env, stdout });
  } catch (err) {
    fail(`${params.serviceNoun} uninstall failed: ${String(err)}`);
    return;
  }

  loaded = false;
  try {
    loaded = await params.service.isLoaded({ env });
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
  env?: GatewayServiceEnv;
}) {
  const json = Boolean(params.opts?.json);
  const env = params.env ?? params.opts?.env ?? (process.env as GatewayServiceEnv);
  const { stdout, emit, fail } = createActionIO({ action: "start", json });

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
    env,
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
      env,
    });
    return;
  }
  try {
    await params.service.restart({ env, stdout });
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
    return;
  }

  let started = true;
  try {
    started = await params.service.isLoaded({ env });
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
  env?: GatewayServiceEnv;
}) {
  const json = Boolean(params.opts?.json);
  const env = params.env ?? params.opts?.env ?? (process.env as GatewayServiceEnv);
  const { stdout, emit, fail } = createActionIO({ action: "stop", json });

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
    env,
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
    await params.service.stop({ env, stdout });
  } catch (err) {
    fail(`${params.serviceNoun} stop failed: ${String(err)}`);
    return;
  }

  let stopped = false;
  try {
    stopped = await params.service.isLoaded({ env });
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
  env?: GatewayServiceEnv;
}): Promise<boolean> {
  const json = Boolean(params.opts?.json);
  const env = params.env ?? params.opts?.env ?? (process.env as GatewayServiceEnv);
  const { stdout, emit, fail } = createActionIO({ action: "restart", json });

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
    env,
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
      env,
    });
    return false;
  }

  const warnings: string[] = [];
  if (params.checkTokenDrift) {
    // Check for token drift before restart (service token vs config token)
    try {
      const command = await params.service.readCommand(env);
      const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN;
      const cfg = loadConfig();
      const configToken = resolveGatewayCredentialsFromConfig({
        cfg,
        env: env as NodeJS.ProcessEnv,
        modeOverride: "local",
      }).token;
      const driftIssue = checkTokenDrift({ serviceToken, configToken });
      if (driftIssue) {
        const warning = driftIssue.detail
          ? `${driftIssue.message} ${driftIssue.detail}`
          : driftIssue.message;
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${driftIssue.message}`);
          if (driftIssue.detail) {
            defaultRuntime.log(`   ${driftIssue.detail}\n`);
          }
        }
      }
    } catch {
      // Non-fatal: token drift check is best-effort
    }
  }

  try {
    await params.service.restart({ env, stdout });
    if (params.postRestartCheck) {
      await params.postRestartCheck({ json, stdout, warnings, fail });
    }
    let restarted = true;
    try {
      restarted = await params.service.isLoaded({ env });
    } catch {
      restarted = true;
    }
    emit({
      ok: true,
      result: "restarted",
      service: buildDaemonServiceSnapshot(params.service, restarted),
      warnings: warnings.length ? warnings : undefined,
    });
    return true;
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
    return false;
  }
}
