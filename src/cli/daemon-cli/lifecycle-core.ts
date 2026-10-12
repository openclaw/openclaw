// Gateway service lifecycle command core: install, uninstall, start, stop, restart.
import { readBestEffortConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { checkManagedServiceEnvDrift, checkTokenDrift } from "../../daemon/service-audit.js";
import { readGatewayServiceLoadState } from "../../daemon/service-load-state.js";
import {
  collectGatewayServiceStartRepairIssues,
  formatGatewayServiceStartRepairIssues,
} from "../../daemon/service-start-repair.js";
import type { GatewayServiceRestartResult } from "../../daemon/service-types.js";
import type {
  GatewayServiceStartRepairIssue,
  GatewayServiceState,
  GatewayService,
} from "../../daemon/service.js";
import {
  describeGatewayServiceRestart,
  readGatewayServiceState,
  startGatewayService,
} from "../../daemon/service.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { isGatewaySecretRefUnavailableError } from "../../gateway/credentials.js";
import { GatewayRestartPreparationError } from "../../infra/restart-intent-error.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import { formatInvalidConfigRecoveryHint } from "../config-recovery-hints.js";
import { resolveGatewayTokenForDriftCheck } from "./gateway-token-drift.js";
import { getServiceActionPreflightFailure } from "./lifecycle-action-preflight.js";
import {
  appendServiceLifecycleRepairAudit,
  createServiceLifecycleMutationAudit,
} from "./lifecycle-audit.js";
import { createServiceRestartIntent } from "./lifecycle-restart-intent.js";
import { buildDaemonServiceSnapshot, createDaemonActionContext } from "./response.js";
import { filterContainerGenericHints, resolveDaemonInstallBlockMessage } from "./shared.js";
import type { DaemonLifecycleOptions } from "./types.js";

type ServiceLifecycleOptions = DaemonLifecycleOptions & {
  restartIntent?: GatewayRestartIntent;
};

type ServiceTarget = {
  serviceNoun: string;
  service: GatewayService;
};

type StartPostCheckContext = Pick<
  ReturnType<typeof createDaemonActionContext>,
  "stdout" | "warnings" | "fail"
> & {
  json: boolean;
  warn?: (message: string) => void;
};

type RestartPostCheckContext = StartPostCheckContext & {
  activationAccepted: boolean;
  preserveDefinition?: boolean;
};

type ServiceRecoveryResult<TResult extends "started" | "stopped" | "restarted"> = {
  result: TResult;
  message?: string;
  warnings?: string[];
  loaded?: boolean;
};

type ServiceRecoveryContext = Omit<StartPostCheckContext, "warnings">;

type ServiceStartRepairContext = ServiceRecoveryContext & {
  state: GatewayServiceState;
  issues: GatewayServiceStartRepairIssue[];
};

function mergeWarnings(
  captured: readonly string[],
  reported?: readonly string[],
): string[] | undefined {
  const combined = [...captured, ...(reported ?? [])];
  return combined.length > 0 ? combined : undefined;
}

async function failServiceNotLoaded(
  params: ServiceTarget & { renderStartHints: () => string[] },
  fail: ReturnType<typeof createDaemonActionContext>["fail"],
) {
  let hints = params.renderStartHints();
  if (process.platform === "linux" && !(await isSystemdUserServiceAvailable().catch(() => false))) {
    hints = [
      ...hints,
      ...renderSystemdUnavailableHints({ wsl: await isWSL(), kind: "generic_unavailable" }),
    ];
  }
  fail(
    `${params.serviceNoun} service ${params.service.notLoadedText}.`,
    filterContainerGenericHints(hints),
  );
}

async function resolveServiceLoadedOrFail(
  params: ServiceTarget,
  fail: ReturnType<typeof createDaemonActionContext>["fail"],
  opts: { acceptInstalledDefinition?: boolean; inspectionFailureMessage?: string } = {},
): Promise<boolean | null> {
  // Keep native scope discovery in the adapter and failure emission in the action context.
  const hasInstalledDefinition = async () =>
    params.service.hasInstalledDefinition
      ? await params.service.hasInstalledDefinition({ env: process.env }).catch(() => false)
      : Boolean(await params.service.readCommand(process.env).catch(() => null));
  const loadState = await readGatewayServiceLoadState(params.service, { env: process.env });
  if (loadState.status === "unknown") {
    fail(
      `${opts.inspectionFailureMessage ?? `${params.serviceNoun} service check failed`}: ${loadState.detail}`,
    );
    return null;
  }
  return (
    loadState.status === "loaded" ||
    (Boolean(opts.acceptInstalledDefinition) && (await hasInstalledDefinition()))
  );
}

function warnServiceConfig(
  issue: Awaited<ReturnType<typeof getServiceActionPreflightFailure>>,
  context: { json: boolean; warnings: string[] },
) {
  if (!issue) {
    return;
  }
  const warning = [
    `Config needs repair: ${issue.message}`,
    ...(issue.hints ?? []),
    formatCliCommand("openclaw doctor --fix"),
  ].join("\n");
  context.warnings.push(warning);
  if (!context.json) {
    defaultRuntime.error(`WARNING: ${warning}`);
  }
}

export async function runServiceUninstall(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: ServiceLifecycleOptions;
  stopBeforeUninstall: boolean;
  assertNotLoadedAfterUninstall: boolean;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, warnings, emit, fail } = createDaemonActionContext({ action: "uninstall", json });

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service uninstall is disabled.");
    return;
  }

  let loaded = await resolveServiceLoadedOrFail(params, fail, {
    inspectionFailureMessage: `${params.serviceNoun} uninstall aborted because service status is unknown; resolve the inspection error before retrying`,
  });
  if (loaded === null) {
    return;
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
  loaded = await resolveServiceLoadedOrFail(params, fail, {
    inspectionFailureMessage: `${params.serviceNoun} uninstall verification failed because service status is unknown`,
  });
  if (loaded === null) {
    return;
  }
  if (loaded && params.assertNotLoadedAfterUninstall) {
    fail(`${params.serviceNoun} service still loaded after uninstall.`);
    return;
  }
  warnServiceConfig(await getServiceActionPreflightFailure("uninstall"), { json, warnings });
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
  opts?: ServiceLifecycleOptions;
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult<"started"> | null>;
  repairLoadedService?: (
    ctx: ServiceStartRepairContext,
  ) => Promise<ServiceRecoveryResult<"started"> | null>;
  /** Verifies readiness before start reports success, including an already-running process. */
  postStartCheck?: (ctx: StartPostCheckContext) => Promise<void>;
  expectedPort?: number;
}) {
  const json = Boolean(params.opts?.json);
  const serviceCommand = formatCliCommand(`openclaw ${params.serviceNoun.toLowerCase()}`);
  const { stdout, warnings, emitMessage, fail } = createDaemonActionContext({
    action: "start",
    json,
  });
  const warn = json ? (message: string) => warnings.push(message) : undefined;
  let postCheckFailed = false;
  const checkReadiness = async () => {
    await params.postStartCheck?.({
      json,
      stdout,
      warnings,
      warn,
      fail: (message, hints, result) => {
        postCheckFailed = true;
        fail(message, hints, result);
      },
    });
    return !postCheckFailed;
  };
  const emitStarted = async (result: {
    loaded: boolean;
    message?: string;
    reportedWarnings?: readonly string[];
  }) => {
    if (!(await checkReadiness())) {
      return;
    }
    emitMessage({
      ok: true,
      result: "started",
      message: result.message,
      warnings: mergeWarnings(warnings, result.reportedWarnings),
      service: buildDaemonServiceSnapshot(params.service, result.loaded),
    });
  };
  const loaded = await resolveServiceLoadedOrFail(params, fail);

  if (loaded === null) {
    return;
  }
  // Validate before both loaded and not-loaded start paths (#35862).
  const preflight = await getServiceActionPreflightFailure("start");
  if (preflight) {
    fail(
      !preflight.hints
        ? `${params.serviceNoun} aborted: config is invalid.\n${preflight.message}\n${formatInvalidConfigRecoveryHint()}`
        : `${params.serviceNoun} start blocked: ${preflight.message}`,
      preflight.hints,
    );
    return;
  }
  if (!loaded) {
    try {
      const handled = await params.onNotLoaded?.({ json, stdout, warn, fail });
      if (handled) {
        await emitStarted({
          loaded: handled.loaded ?? false,
          message: handled.message,
          reportedWarnings: handled.warnings,
        });
        return;
      }
    } catch (err) {
      if (postCheckFailed || err instanceof ExitError) {
        throw err;
      }
      fail(`${params.serviceNoun} start failed: ${String(err)}`, params.renderStartHints());
      return;
    }
  }
  try {
    const startResult = await startGatewayService(
      params.service,
      {
        env: process.env,
        stdout,
        warn,
        onMutation: createServiceLifecycleMutationAudit({
          serviceNoun: params.serviceNoun,
          action: "start",
        }),
      },
      params.expectedPort,
    );
    if (startResult.outcome === "missing-install") {
      await failServiceNotLoaded(params, fail);
      return;
    }
    if (startResult.outcome === "already-running") {
      if (startResult.issues.length > 0) {
        // Only services with a repair callback can rebuild their definition during restart.
        const repairAction = params.repairLoadedService ? "restart" : "install --force";
        const warning = `${params.serviceNoun} service already running, but its installed service definition needs repair: ${formatGatewayServiceStartRepairIssues(startResult.issues)}; run \`${serviceCommand} ${repairAction}\` to apply.`;
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(warning);
        }
      }
      if (!(await checkReadiness())) {
        return;
      }
      const pid = startResult.state.runtime?.pid;
      emitMessage({
        ok: true,
        result: "already-running",
        message: `${params.serviceNoun} service already running${pid === undefined ? "" : ` (pid ${pid})`}.`,
        service: buildDaemonServiceSnapshot(params.service, true),
        warnings: warnings.length ? warnings : undefined,
      });
      return;
    }
    if (startResult.outcome === "repair-required") {
      try {
        const handled = await params.repairLoadedService?.({
          json,
          stdout,
          warn,
          fail,
          state: startResult.state,
          issues: startResult.issues,
        });
        if (handled) {
          appendServiceLifecycleRepairAudit({
            serviceNoun: params.serviceNoun,
            action: "start",
          });
          await emitStarted({
            loaded: handled.loaded ?? true,
            message: handled.message,
            reportedWarnings: handled.warnings,
          });
          return;
        }
      } catch (err) {
        if (postCheckFailed || err instanceof ExitError) {
          throw err;
        }
        fail(`${params.serviceNoun} repair failed: ${String(err)}`, params.renderStartHints());
        return;
      }
      fail(
        `${params.serviceNoun} service needs repair before it can start: ${formatGatewayServiceStartRepairIssues(startResult.issues)}`,
        [`${serviceCommand} install --force`],
      );
      return;
    }
    const serviceLoaded = startResult.state.loadState.status === "loaded";
    await emitStarted({ loaded: serviceLoaded });
  } catch (err) {
    if (postCheckFailed || err instanceof ExitError) {
      throw err;
    }
    fail(`${params.serviceNoun} start failed: ${String(err)}`, params.renderStartHints());
  }
}

export async function runServiceStop(params: {
  serviceNoun: string;
  service: GatewayService;
  opts?: ServiceLifecycleOptions;
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult<"stopped"> | null>;
  stopWhenNotLoaded?: boolean;
}) {
  const json = Boolean(params.opts?.json);
  const { stdout, warnings, emit, emitMessage, fail } = createDaemonActionContext({
    action: "stop",
    json,
  });
  const gatewayStopAudit = createServiceLifecycleMutationAudit({
    serviceNoun: params.serviceNoun,
    action: "stop",
  });

  const loaded = await resolveServiceLoadedOrFail(params, fail);
  if (loaded === null) {
    return;
  }
  if (!loaded && !params.stopWhenNotLoaded) {
    try {
      const handled = await params.onNotLoaded?.({ json, stdout, fail });
      if (handled) {
        warnServiceConfig(await getServiceActionPreflightFailure("stop"), { json, warnings });
        emitMessage({
          ok: true,
          result: handled.result,
          message: handled.message,
          warnings: mergeWarnings(warnings, handled.warnings),
          service: buildDaemonServiceSnapshot(params.service, false),
        });
        return;
      }
    } catch (err) {
      if (err instanceof ExitError) {
        throw err;
      }
      fail(`${params.serviceNoun} stop failed: ${String(err)}`);
      return;
    }
    warnServiceConfig(await getServiceActionPreflightFailure("stop"), { json, warnings });
    emitMessage({
      ok: true,
      result: "not-loaded",
      message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
      service: buildDaemonServiceSnapshot(params.service, loaded),
    });
    return;
  }
  try {
    await params.service.stop({
      env: process.env,
      stdout,
      disable: params.opts?.disable,
      onMutation: gatewayStopAudit,
    });
  } catch (err) {
    fail(`${params.serviceNoun} stop failed: ${String(err)}`);
    return;
  }

  const finalLoaded = loaded
    ? await resolveServiceLoadedOrFail(params, fail, {
        inspectionFailureMessage: `${params.serviceNoun} stop verification failed because service status is unknown`,
      })
    : false;
  if (finalLoaded === null) {
    return;
  }
  warnServiceConfig(await getServiceActionPreflightFailure("stop"), { json, warnings });
  emit({
    ok: true,
    result: "stopped",
    service: buildDaemonServiceSnapshot(params.service, finalLoaded),
  });
}

export async function runServiceRestart(params: {
  serviceNoun: string;
  service: GatewayService;
  renderStartHints: () => string[];
  opts?: ServiceLifecycleOptions;
  checkTokenDrift?: boolean;
  expectedPort?: number;
  beforeServiceMutation?: () => void;
  repairLoadedService?: (
    ctx: ServiceStartRepairContext,
  ) => Promise<ServiceRecoveryResult<"restarted"> | null>;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<GatewayServiceRestartResult | void>;
  onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult<"restarted"> | null>;
  restartOwnedProcess?: (
    ctx: ServiceRecoveryContext,
  ) => Promise<ServiceRecoveryResult<"restarted"> | null>;
}): Promise<boolean> {
  const json = Boolean(params.opts?.json);
  const { stdout, warnings, emitMessage, fail } = createDaemonActionContext({
    action: "restart",
    json,
  });
  const warn = json ? (message: string) => warnings.push(message) : undefined;
  const renderRestartFailureHints = (error: unknown) =>
    error instanceof GatewayRestartPreparationError && error.reason === "serving-owner"
      ? [
          formatCliCommand("openclaw gateway status --deep"),
          `Fix the reported startup failure, then run \`${formatCliCommand("openclaw gateway start")}\` to wait for readiness without restarting the process.`,
        ]
      : params.renderStartHints();
  const restartIntent = params.opts?.restartIntent;
  const gatewayRestartAudit = createServiceLifecycleMutationAudit({
    serviceNoun: params.serviceNoun,
    action: "restart",
  });
  let handledRecovery: ServiceRecoveryResult<"restarted"> | null = null;
  let handledRepair: ServiceRecoveryResult<"restarted"> | null = null;
  let recoveredLoadedState: boolean | null = null;
  const { prepare: prepareGatewayRestartIntent, clear: clearPreparedRestartIntent } =
    createServiceRestartIntent({
      serviceNoun: params.serviceNoun,
      service: params.service,
      intent: restartIntent,
    });
  const emitScheduledRestart = (
    restartStatus: ReturnType<typeof describeGatewayServiceRestart>,
    serviceLoaded: boolean,
  ): true => {
    emitMessage({
      ok: true,
      result: restartStatus.daemonActionResult,
      message: restartStatus.message,
      service: buildDaemonServiceSnapshot(params.service, serviceLoaded),
      warnings: warnings.length ? warnings : undefined,
    });
    return true;
  };

  const loaded = await resolveServiceLoadedOrFail(params, fail, {
    acceptInstalledDefinition: true,
  });
  if (loaded === null) {
    return false;
  }

  // An invalid candidate must not prevent control of the installed service or
  // regenerate its definition from config that Doctor has not repaired yet.
  const configIssue = await getServiceActionPreflightFailure("restart");

  if (params.restartOwnedProcess) {
    try {
      handledRecovery = await params.restartOwnedProcess({ json, stdout, warn, fail });
    } catch (err) {
      if (err instanceof ExitError) {
        throw err;
      }
      fail(`${params.serviceNoun} restart failed: ${String(err)}`);
      return false;
    }
  }

  // Loaded services cross the native mutation boundary here. Not-loaded recovery
  // may still target a separately verified unmanaged listener.
  if (loaded && !handledRecovery) {
    params.beforeServiceMutation?.();
  }

  if (!loaded && !handledRecovery) {
    try {
      handledRecovery = (await params.onNotLoaded?.({ json, stdout, warn, fail })) ?? null;
    } catch (err) {
      if (err instanceof ExitError) {
        throw err;
      }
      fail(`${params.serviceNoun} restart failed: ${String(err)}`);
      return false;
    }
    if (!handledRecovery) {
      await failServiceNotLoaded(params, fail);
      return false;
    }
    if (handledRecovery.warnings?.length) {
      warnings.push(...handledRecovery.warnings);
    }
    recoveredLoadedState = handledRecovery.loaded ?? null;
  }

  if (loaded && !handledRecovery && !configIssue && params.repairLoadedService) {
    try {
      const state = await readGatewayServiceState(params.service, { env: process.env });
      const issues = collectGatewayServiceStartRepairIssues(state, params.expectedPort);
      if (issues.length > 0) {
        await prepareGatewayRestartIntent();
        handledRepair = await params.repairLoadedService({
          json,
          stdout,
          warn,
          fail,
          state,
          issues,
        });
        if (!handledRepair) {
          clearPreparedRestartIntent();
          fail(
            `${params.serviceNoun} service needs repair before restart: ${formatGatewayServiceStartRepairIssues(issues)}`,
            [formatCliCommand("openclaw gateway install --force")],
          );
          return false;
        }
        appendServiceLifecycleRepairAudit({
          serviceNoun: params.serviceNoun,
          action: "restart",
          pid: state.runtime?.pid,
        });
        if (handledRepair.warnings?.length) {
          warnings.push(...handledRepair.warnings);
        }
      }
    } catch (err) {
      clearPreparedRestartIntent();
      if (err instanceof ExitError) {
        throw err;
      }
      const hints = renderRestartFailureHints(err);
      fail(`${params.serviceNoun} repair failed: ${String(err)}`, hints);
      return false;
    }
  }

  if (loaded && !handledRecovery && !configIssue && params.checkTokenDrift) {
    // Check for token drift before restart (service token vs config token)
    let command: Awaited<ReturnType<typeof params.service.readCommand>> = null;
    let cfg: OpenClawConfig | null = null;
    let driftEnv: Record<string, string | undefined> = process.env;
    try {
      command = await params.service.readCommand(process.env);
      cfg = await readBestEffortConfig();
      driftEnv = {
        ...process.env,
        ...command?.environment,
      };
      const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN;
      const configToken = await resolveGatewayTokenForDriftCheck({ cfg, env: driftEnv });
      const driftIssue = checkTokenDrift({ serviceToken, configToken });
      if (driftIssue) {
        const recovery =
          resolveDaemonInstallBlockMessage("gateway") ??
          `Run \`${formatCliCommand("openclaw gateway install --force")}\` to refresh the service token source.`;
        const warning = `${driftIssue.message} ${recovery}`;
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${warning}\n`);
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

    try {
      const { collectDurableServiceEnvVarSources } =
        await import("../../config/state-dir-dotenv.js");
      const { collectEnvSecretRefIds } = await import("../../config/resolution-facts.js");
      const { durableEnvironment } = collectDurableServiceEnvVarSources({
        env: driftEnv,
        config: cfg ?? undefined,
      });
      const secretRefKeys = cfg ? collectEnvSecretRefIds(cfg) : undefined;
      const envDriftIssue = checkManagedServiceEnvDrift({
        serviceEnvironment: command?.environment,
        durableEnvironment,
        secretRefKeys,
      });
      if (envDriftIssue) {
        const recovery =
          resolveDaemonInstallBlockMessage("gateway") ??
          `Run \`${formatCliCommand("openclaw gateway install --force")}\` to refresh the service environment.`;
        const warning = `${envDriftIssue.message} ${recovery}`;
        warnings.push(warning);
        if (!json) {
          defaultRuntime.log(`\n⚠️  ${warning}\n`);
        }
      }
    } catch {
      // Best-effort drift inspection; ignore inspection failures
    }
  }

  let postCheckFailed = false;
  try {
    let restartResult: GatewayServiceRestartResult | undefined;
    if (loaded && !handledRepair && !handledRecovery) {
      await prepareGatewayRestartIntent();
      try {
        restartResult = await params.service.restart({
          preserveDefinition: configIssue ? true : params.opts?.preserveDefinition,
          env: process.env,
          stdout,
          warn,
          onMutation: gatewayRestartAudit,
        });
      } catch (err) {
        clearPreparedRestartIntent();
        throw err;
      }
    }
    warnServiceConfig(configIssue, { json, warnings });
    let restartStatus = describeGatewayServiceRestart(
      params.serviceNoun,
      restartResult ?? { outcome: "completed" },
    );
    if (restartStatus.scheduled) {
      return emitScheduledRestart(restartStatus, loaded || recoveredLoadedState === true);
    }
    if (params.postRestartCheck) {
      const postRestartResult = await params.postRestartCheck({
        json,
        stdout,
        warnings,
        warn,
        // Definition repair alone does not record native activation.
        activationAccepted: restartResult?.outcome === "completed" || Boolean(handledRecovery),
        preserveDefinition: configIssue ? true : params.opts?.preserveDefinition,
        fail: (message, hints, result) => {
          postCheckFailed = true;
          fail(message, hints, result);
        },
      });
      if (postRestartResult) {
        restartStatus = describeGatewayServiceRestart(params.serviceNoun, postRestartResult);
        if (restartStatus.scheduled) {
          return emitScheduledRestart(restartStatus, loaded || recoveredLoadedState === true);
        }
      }
    }
    emitMessage({
      ok: true,
      result: "restarted",
      message: handledRecovery?.message ?? handledRepair?.message,
      service: buildDaemonServiceSnapshot(params.service, loaded || recoveredLoadedState === true),
      warnings: warnings.length ? warnings : undefined,
    });
    return true;
  } catch (err) {
    // A non-exiting runtime unwinds after emission; never replace that result.
    if (postCheckFailed || err instanceof ExitError) {
      throw err;
    }
    const hints = renderRestartFailureHints(err);
    fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
    return false;
  }
}
