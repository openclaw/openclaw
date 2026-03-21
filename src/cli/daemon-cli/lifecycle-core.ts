import type { Writable } from "node:stream";
import { readBestEffortConfig, readConfigFileSnapshot } from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { checkTokenDrift } from "../../daemon/service-audit.js";
import type { GatewayServiceRestartResult } from "../../daemon/service-types.js";
import { describeGatewayServiceRestart } from "../../daemon/service.js";
import type { GatewayService } from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { isGatewaySecretRefUnavailableError } from "../../gateway/credentials.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveGatewayTokenForDriftCheck } from "./gateway-token-drift.js";
import {
  buildDaemonServiceSnapshot,
  createNullWriter,
  type DaemonAction,
  type DaemonActionResponse,
  emitDaemonActionJson,
} from "./response.js";

type DaemonLifecycleOptions = {
  json?: boolean;
};

type RestartPostCheckContext = {
  json: boolean;
  stdout: Writable;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

type NotLoadedActionResult = {
  result: "stopped" | "restarted";
  message?: string;
  warnings?: string[];
};

type NotLoadedActionContext = {
  json: boolean;
  stdout: Writable;
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

/**
 * Best-effort config validation. Returns a string describing the issues if
 * config exists and is invalid, or null if config is valid/missing/unreadable.
 *
 * Note: This reads the config file snapshot in the current CLI environment.
 * Configs using env vars only available in the service context (launchd/systemd)
 * may produce false positives, but the check is intentionally best-effort —
 * a false positive here is safer than a crash on startup. (#35862)
 */
async function getConfigValidationError(): Promise<string | null> {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.exists || snapshot.valid) {
      return null;
    }
    return snapshot.issues.length > 0
      ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
      : "Unknown validation issue.";
  } catch {
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
  // Pre-flight config validation (#35862)
  {
    const configError = await getConfigValidationError();
    if (configError) {
      fail(
        `${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`,
      );
      return;
    }
  }

  try {
    const restartResult = await params.service.restart({ env: process.env, stdout });
    const restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
    if (restartStatus.scheduled) {
      emit({
        ok: true,
        result: restartStatus.daemonActionResult,
        message: restartStatus.message,
        service: buildDaemonServiceSnapshot(params.service, loaded),
      });
      if (!json) {
        defaultRuntime.log(restartStatus.message);
      }
      return;
    }
  } catch (err) {
    if (!loaded) {
      // Re-bootstrap failed (plist does not exist) — service was never installed.
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
  onNotLoaded?: (ctx: NotLoadedActionContext) => Promise<NotLoadedActionResult | null>;
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
    try {
      const handled = await params.onNotLoaded?.({ json, stdout, fail });
      if (handled) {
        emit({
          ok: true,
          result: handled.result,
          message: handled.message,
          warnings: handled.warnings,
          service: buildDaemonServiceSnapshot(params.service, false),
        });
        if (!json && handled.message) {
          defaultRuntime.log(handled.message);
        }
        return;
      }
    } catch (err) {
      fail(`${params.serviceNoun} stop failed: ${String(err)}`);
      return;
    }
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
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<GatewayServiceRestartResult | void>;
  onNotLoaded?: (ctx: NotLoadedActionContext) => Promise<NotLoadedActionResult | null>;
}): Promise<boolean> {
  const json = Boolean(params.opts?.json);
  const { stdout, emit, fail } = createActionIO({ action: "restart", json });
  const warnings: string[] = [];
  let handledNotLoaded: NotLoadedActionResult | null = null;
  const emitScheduledRestart = (
    restartStatus: ReturnType<typeof describeGatewayServiceRestart>,
    serviceLoaded: boolean,
  ) => {
    emit({
      ok: true,
      result: restartStatus.daemonActionResult,
      message: restartStatus.message,
      service: buildDaemonServiceSnapshot(params.service, serviceLoaded),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(restartStatus.message);
    }
    return true;
  };

  const loaded = await resolveServiceLoadedOrFail({
    serviceNoun: params.serviceNoun,
    service: params.service,
    fail,
  });
  if (loaded === null) {
    return false;
  }

  // Pre-flight config validation: check before any restart action (including
  // onNotLoaded which may send SIGUSR1 to an unmanaged process). (#35862)
  {
    const configError = await getConfigValidationError();
    if (configError) {
      fail(
        `${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`,
      );
      return false;
    }
  }

  if (!loaded) {
    try {
      handledNotLoaded = (await params.onNotLoaded?.({ json, stdout, fail })) ?? null;
    } catch (err) {
      fail(`${params.serviceNoun} restart failed: ${String(err)}`);
      return false;
    }
    if (!handledNotLoaded) {
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
    if (handledNotLoaded.warnings?.length) {
      warnings.push(...handledNotLoaded.warnings);
    }
  }

  if (loaded && params.checkTokenDrift) {
    // Check for token drift before restart (service token vs config token)
    try {
      const command = await params.service.readCommand(process.env);
      const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN;
      const cfg = await readBestEffortConfig();
      const configToken = resolveGatewayTokenForDriftCheck({ cfg, env: process.env });
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
    } catch (err) {
      if (isGatewaySecretRefUnavailableError(err, "gateway.auth.token")) {
        const warning =
          "Unable to verify gateway token drift: gateway.auth.token SecretRef is configured but unavailable in this command path.";
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${warning}\n`);
        }
      }
    }
  }

  try {
    let restartResult: GatewayServiceRestartResult = { outcome: "completed" };
    if (loaded) {
      restartResult = await params.service.restart({ env: process.env, stdout });
    }
    let restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
    if (restartStatus.scheduled) {
      return emitScheduledRestart(restartStatus, loaded);
    }
    if (params.postRestartCheck) {
      const postRestartResult = await params.postRestartCheck({ json, stdout, warnings, fail });
      if (postRestartResult) {
        restartStatus = describeGatewayServiceRestart(params.serviceNoun, postRestartResult);
        if (restartStatus.scheduled) {
          return emitScheduledRestart(restartStatus, loaded);
        }
      }
    }
    let restarted = loaded;
    if (loaded) {
      try {
        restarted = await params.service.isLoaded({ env: process.env });
      } catch {
        restarted = true;
      }
    }
    emit({
      ok: true,
      result: "restarted",
      message: handledNotLoaded?.message,
      service: buildDaemonServiceSnapshot(params.service, restarted),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json && handledNotLoaded?.message) {
      defaultRuntime.log(handledNotLoaded.message);
    }
    return true;
  } catch (err) {
    const hints = params.renderStartHints();
    fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
    return false;
  }
}
