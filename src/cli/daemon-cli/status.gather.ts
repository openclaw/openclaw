import {
  isDefaultInstallIdentity,
  resolveConfigPath,
  resolveStateDir,
} from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveSecretInputRef } from "../../config/types.secrets.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import { inspectGatewayHeapLimit } from "../../daemon/gateway-heap.js";
import type { FindExtraGatewayServicesOptions } from "../../daemon/inspect.js";
import { formatServiceLabel } from "../../daemon/runtime-format.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import {
  inspectGatewayServiceInstallationDrift,
  summarizeGatewayServiceLayout,
} from "../../daemon/service-layout.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { projectGatewayUrlForDiagnostics } from "../../gateway/connection-details.js";
import { gatewaySecretInputPathCanWin } from "../../gateway/credentials-secret-inputs.js";
import { trimToUndefined } from "../../gateway/credentials.js";
import { resolveGatewayRequiredListenHosts } from "../../gateway/net.js";
import { resolveGatewayProbeCredentialConfig } from "../../gateway/probe-auth.js";
import {
  ALL_GATEWAY_SECRET_INPUT_PATHS,
  readGatewaySecretInputValue,
} from "../../gateway/secret-input-paths.js";
import {
  readGatewayLastShutdownAsync,
  readGatewayRecentCrashesAsync,
} from "../../infra/gateway-boot-lifecycle.js";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { inspectPortConnections } from "../../infra/ports-inspect.js";
import type { PortConnection } from "../../infra/ports-types.js";
import { resolveEnvironmentValue } from "../../infra/process-env.js";
import { readGatewayRestartHandoffSync } from "../../infra/restart-handoff.js";
import { describeUnreadableStateDatabase } from "../../infra/state-repair-message.js";
import { inspectWindowsGatewayFirewall } from "../../infra/windows-gateway-firewall-diagnostics.js";
import { resolveConfiguredLogFilePath } from "../../logging/log-file-path.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-record-reader.js";
import {
  detectPluginVersionDrift,
  hasOfficialPluginVersionCandidates,
  type PluginVersionDriftReport,
  type PluginVersionRestartReadiness,
} from "../../plugins/plugin-version-drift.js";
import { VERSION } from "../../version.js";
import { resolveGatewayLocalPortOverride } from "../gateway-port-option.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";
import { formatGatewayServiceInstallationDrift, type GatewayCrashHistory } from "./shared.js";
import { readDaemonStatusConfig } from "./status.config.js";
import { inspectDaemonPortStatuses, resolveGatewayStatusSummary } from "./status.gateway.js";
import { projectDaemonRuntimeStatus } from "./status.projection.js";
import { readDaemonServiceStatus } from "./status.service.js";
import type { GatewayRpcOpts } from "./types.js";

async function loadDaemonConfigContext(
  command: GatewayServiceCommandConfig | null,
  opts: { deep?: boolean } = {},
) {
  const mergedDaemonEnv = mergeGatewayServiceEnv(process.env, command);

  const cliConfigPath = resolveConfigPath(process.env, resolveStateDir(process.env));
  const daemonConfigPath = resolveConfigPath(mergedDaemonEnv, resolveStateDir(mergedDaemonEnv));
  const sameConfigPath = cliConfigPath === daemonConfigPath;
  const cliConfigRead = await readDaemonStatusConfig({
    env: process.env,
    configPath: cliConfigPath,
    deep: opts.deep,
  });
  const sharesDaemonConfigContext = sameConfigPath && (cliConfigRead.mode === "fast" || !command);
  const daemonConfigRead = sharesDaemonConfigContext
    ? cliConfigRead
    : await readDaemonStatusConfig({
        env: mergedDaemonEnv,
        configPath: daemonConfigPath,
        deep: opts.deep,
      });

  return {
    mergedDaemonEnv,
    cliCfg: cliConfigRead.cfg,
    daemonCfg: daemonConfigRead.cfg,
    cliConfigSummary: cliConfigRead.summary,
    daemonConfigSummary: daemonConfigRead.summary,
    configMismatch: cliConfigRead.summary.path !== daemonConfigRead.summary.path,
  };
}

async function inspectEstablishedGatewayClients(params: {
  daemonPort: number;
  deep?: boolean;
  gatewayMode?: string;
}): Promise<{ port: number; established: PortConnection[] } | undefined> {
  if (params.deep !== true || params.gatewayMode === "remote") {
    return undefined;
  }
  const result = await inspectPortConnections(params.daemonPort).catch(() => null);
  const establishedClients = result?.connections.filter(
    (connection) => connection.direction !== "server",
  );
  if (!result || !establishedClients || establishedClients.length === 0) {
    return undefined;
  }
  return {
    port: result.port,
    established: establishedClients,
  };
}

function hasActiveGatewayExecProbeCredential(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitAuth: { token?: string; password?: string };
}): boolean {
  const cfg = resolveGatewayProbeCredentialConfig({
    cfg: params.cfg,
    mode: "local",
  });
  return ALL_GATEWAY_SECRET_INPUT_PATHS.some((path) => {
    if (
      !gatewaySecretInputPathCanWin({
        config: cfg,
        env: params.env,
        explicitAuth: params.explicitAuth,
        modeOverride: "local",
        path,
        // Remote probe config suppresses ambient credentials across auth types.
        // Mirror that owner here so env auth cannot hide a winning exec ref.
        remoteTokenFallback: "remote-only",
        remotePasswordFallback: "remote-only",
      })
    ) {
      return false;
    }
    const ref = resolveSecretInputRef({
      value: readGatewaySecretInputValue(cfg, path),
      defaults: cfg.secrets?.defaults,
    }).ref;
    return ref?.source === "exec";
  });
}

async function gatherDaemonStatusImpl(
  opts: {
    rpc: GatewayRpcOpts;
    dashboardTarget?: { port: number; probeUrl: string };
    probe: boolean;
    requireRpc?: boolean;
    signal?: AbortSignal;
    deep?: boolean;
    allowExecSecretRefs?: boolean;
    pluginVersionTarget?: "running" | "restart";
  } & FindExtraGatewayServicesOptions,
) {
  const localPortOverride = resolveGatewayLocalPortOverride(opts.rpc);
  const timeoutMs = parseTimeoutMsWithFallback(opts.rpc.timeout, 10_000, {
    invalidType: "error",
  });
  const { service, state: serviceState } = await readDaemonServiceStatus({
    env: process.env,
    timeoutMs:
      process.platform === "win32" && opts.rpc.timeout === undefined ? undefined : timeoutMs,
  });
  const { command, env: serviceEnv, loadState, runtime } = serviceState;
  const loaded = loadState.status === "loaded";
  // An explicit local port or separate process context does not select the
  // native service. Keep that service visible without borrowing its target or auth.
  const useNativeServiceTargetContext =
    !serviceState.inspectionFailed &&
    localPortOverride === undefined &&
    serviceState.inspectionReason !== "service-manager-unavailable" &&
    isDefaultInstallIdentity(process.env) &&
    !isGatewayExternallySupervised(process.env);
  const targetServiceCommand = useNativeServiceTargetContext ? command : null;
  // The RPC handshake can fail while the service still runs another install, so
  // resolve the locally readable service install facts here and hand them to the
  // renderer instead of leaving it dependent on Gateway metadata.
  const serviceLayout = command
    ? await summarizeGatewayServiceLayout(command).catch(() => undefined)
    : undefined;
  const activePackageRoot = serviceLayout?.packageRootReal
    ? await resolveOpenClawPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
      }).catch(() => null)
    : null;
  const installationDrift = activePackageRoot
    ? await inspectGatewayServiceInstallationDrift(serviceLayout, activePackageRoot).catch(
        () => undefined,
      )
    : undefined;
  if (opts.deep && !trimToUndefined(opts.rpc.url)) {
    const {
      preflightOpenClawDatabaseSchemas,
      OpenClawDatabaseSchemaPreflightError,
      getOpenClawDatabaseReadinessFailure,
    } = await import("../../state/openclaw-database-preflight.js");
    // Diagnose a refused database before config and lifecycle readers try to open it.
    const schemas = await preflightOpenClawDatabaseSchemas({
      env: mergeGatewayServiceEnv(process.env, targetServiceCommand),
      scope: "state",
    });
    if (schemas.incompatible.length > 0) {
      throw new OpenClawDatabaseSchemaPreflightError(schemas.incompatible);
    }
    // Config readers would otherwise report this database failure as a config read failure.
    const unreadableStateDatabase = schemas.indeterminate.find(
      (database) => database.kind === "state",
    );
    if (unreadableStateDatabase) {
      const { problem, recovery } = describeUnreadableStateDatabase(
        unreadableStateDatabase.path,
        unreadableStateDatabase.reason,
        { cause: getOpenClawDatabaseReadinessFailure(unreadableStateDatabase) },
      );
      throw new Error(`${problem}. ${recovery}`);
    }
  }
  const restartHandoff = opts.deep ? readGatewayRestartHandoffSync(serviceEnv) : null;
  const configAudit: ServiceConfigAudit = await import("../../daemon/service-audit.js").then(
    ({ auditGatewayServiceConfig }) =>
      auditGatewayServiceConfig({
        env: process.env,
        command,
        timeoutMs,
      }),
  );
  const {
    mergedDaemonEnv,
    cliCfg,
    daemonCfg,
    cliConfigSummary,
    daemonConfigSummary,
    configMismatch,
  } = await loadDaemonConfigContext(targetServiceCommand, {
    deep: opts.deep,
  });
  const { dashboardTarget } = opts;
  const summary = await resolveGatewayStatusSummary({
    cliCfg,
    daemonCfg,
    // A caller's port override is not evidence of where an installed unit listens.
    mergedDaemonEnv:
      dashboardTarget && targetServiceCommand
        ? {
            ...mergedDaemonEnv,
            OPENCLAW_GATEWAY_PORT: resolveEnvironmentValue(
              targetServiceCommand.environment,
              "OPENCLAW_GATEWAY_PORT",
            ),
          }
        : mergedDaemonEnv,
    commandProgramArguments: targetServiceCommand?.programArguments,
    rpcUrlOverride: opts.rpc.url,
    localPortOverride,
  });
  const { daemonPort } = summary;
  const cliPort = dashboardTarget?.port ?? summary.cliPort;
  const selectedUrl = dashboardTarget && new URL(dashboardTarget.probeUrl);
  const dashboardMatchesNative =
    selectedUrl !== undefined &&
    (loadState.status === "not-loaded" || targetServiceCommand !== null) &&
    dashboardTarget?.port === daemonPort &&
    selectedUrl.protocol === (summary.gateway.tlsEnabled ? "wss:" : "ws:") &&
    (selectedUrl.hostname === "127.0.0.1" || selectedUrl.hostname === summary.gateway.bindHost);
  // Use the existing explicit-URL transport policy for alternate endpoints. Only
  // the matching loopback probe may borrow native service credentials or TLS pins.
  const probeUrlOverride =
    summary.probeUrlOverride ??
    (dashboardTarget && !(dashboardMatchesNative && dashboardTarget.probeUrl === summary.probeUrl)
      ? dashboardTarget.probeUrl
      : null);
  const probeUrl = probeUrlOverride ?? summary.probeUrl;
  const gateway = dashboardTarget
    ? { ...summary.gateway, probeUrl: projectGatewayUrlForDiagnostics(probeUrl) }
    : summary.gateway;
  const hasUrlOverride = Boolean(probeUrlOverride);
  const serviceTargetsProbe =
    useNativeServiceTargetContext &&
    (dashboardTarget ? dashboardMatchesNative && !summary.probeUrlOverride : !hasUrlOverride);
  const shouldInspectLocalGateway = !hasUrlOverride;
  const lastShutdown =
    opts.deep && shouldInspectLocalGateway
      ? await readGatewayLastShutdownAsync(mergedDaemonEnv).catch(() => undefined)
      : undefined;
  const crashHistory: GatewayCrashHistory | undefined = shouldInspectLocalGateway
    ? await readGatewayRecentCrashesAsync(mergedDaemonEnv).then(
        (recentCrashes) => ({ recentCrashes }),
        (error: unknown) => ({ crashHistoryError: String(error) }),
      )
    : undefined;
  let duelingScopesWarning: string | null = null;
  if (opts.deep && serviceTargetsProbe && process.platform === "linux") {
    const { findSystemdGatewayInstallation, formatDuelingScopesWarning } =
      await import("../../daemon/systemd-scope.js");
    const installation = await findSystemdGatewayInstallation(serviceEnv).catch(() => null);
    duelingScopesWarning = installation
      ? formatDuelingScopesWarning(installation, daemonPort)
      : null;
  }
  const windowsFirewall =
    opts.deep === true && shouldInspectLocalGateway
      ? await inspectWindowsGatewayFirewall({
          bind: gateway.bindMode,
          port: daemonPort,
        })
      : undefined;
  const { portStatus, portCliStatus } = await inspectDaemonPortStatuses({
    daemonPort,
    cliPort,
    daemonBindHost: gateway.bindHost,
  });
  const establishedClients = await inspectEstablishedGatewayClients({
    daemonPort,
    deep: opts.deep,
    gatewayMode: shouldInspectLocalGateway ? "local" : "remote",
  });

  const extraServices = opts.deep
    ? await import("../../daemon/inspect.js")
        .then(({ findExtraGatewayServices }) =>
          findExtraGatewayServices(process.env, {
            deep: true,
          }),
        )
        .then(({ services }) =>
          services.filter(
            (extra) =>
              extra.platform !== "linux" ||
              extra.scope !== runtime?.systemd?.scope ||
              extra.label !== runtime?.systemd?.unit,
          ),
        )
        .catch(() => [])
    : [];
  const launchdDiagnostics =
    process.platform === "darwin"
      ? await import("./status.launchd.js").then(({ gatherLaunchdJobDiagnostics }) =>
          gatherLaunchdJobDiagnostics(serviceEnv, Boolean(opts.deep)),
        )
      : {};

  const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
  const localCertificate =
    opts.probe && !probeUrlOverride && tlsEnabled
      ? await import("../../infra/tls/gateway.js").then(({ inspectGatewayTlsCertificate }) =>
          inspectGatewayTlsCertificate(daemonCfg.gateway?.tls),
        )
      : undefined;
  let daemonProbeAuth: { token?: string; password?: string } | undefined;
  let rpcAuthWarning: string | undefined;
  let redactedProbeCredential = false;
  let allowRpcConfigCredentials = true;
  let skippedProbeAuthForDisabledExecSecretRef = false;
  if (opts.probe) {
    const explicitAuth = {
      token: trimToUndefined(opts.rpc.token),
      password: trimToUndefined(opts.rpc.password),
    };
    const canResolveProbeAuth =
      opts.allowExecSecretRefs !== false ||
      !hasActiveGatewayExecProbeCredential({
        cfg: daemonCfg,
        env: mergedDaemonEnv,
        explicitAuth,
      });
    if (probeUrlOverride || explicitAuth.token || explicitAuth.password) {
      daemonProbeAuth = explicitAuth;
    } else if (daemonCfg.gateway?.auth?.mode === "none") {
      daemonProbeAuth = {};
    } else if (canResolveProbeAuth) {
      // Trusted-proxy probes still use the local-direct password owned by this resolver.
      const probeAuthResolution = await import("../../gateway/probe-auth.js").then(
        ({ resolveGatewayProbeAuthSafeWithSecretInputs }) =>
          resolveGatewayProbeAuthSafeWithSecretInputs({
            cfg: daemonCfg,
            mode: "local",
            env: mergedDaemonEnv,
            explicitAuth,
          }),
      );
      daemonProbeAuth = probeAuthResolution.auth;
      rpcAuthWarning = probeAuthResolution.warning;
      redactedProbeCredential = probeAuthResolution.warningCode === "SECRET_REF_REDACTED_VALUE";
    } else {
      allowRpcConfigCredentials = false;
      skippedProbeAuthForDisabledExecSecretRef = true;
      rpcAuthWarning =
        "Gateway check auth skipped because gateway credentials use an exec SecretRef and exec SecretRefs are disabled for this status request.";
    }
  }

  const rpc = opts.probe
    ? await import("./probe.js").then(({ probeGatewayStatus }) =>
        probeGatewayStatus({
          url: probeUrl,
          ...(probeUrlOverride ? { urlOverride: probeUrlOverride } : {}),
          localPortOverride,
          token: daemonProbeAuth?.token,
          password: daemonProbeAuth?.password,
          // Freeze the resolved target and Gateway credentials while preserving
          // endpoint-scoped transport policy for the existing client selectors.
          config: {
            ...daemonCfg,
            gateway: {
              ...daemonCfg.gateway,
              mode: "local",
              remote: daemonCfg.gateway?.remote
                ? {
                    url: daemonCfg.gateway.remote.url,
                    edgeAuth: daemonCfg.gateway.remote.edgeAuth,
                    tlsFingerprint: daemonCfg.gateway.remote.tlsFingerprint,
                  }
                : undefined,
              auth:
                !hasUrlOverride && daemonCfg.gateway?.auth?.mode
                  ? { mode: daemonCfg.gateway.auth.mode }
                  : undefined,
              tls: undefined,
            },
          },
          tlsFingerprint: localCertificate?.ok
            ? localCertificate.value.fingerprintSha256
            : undefined,
          timeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
          json: opts.rpc.json,
          requireRpc: opts.requireRpc,
          allowRpcConfigCredentials,
          configPath: daemonConfigSummary.path,
        }),
      )
    : undefined;
  if (rpc?.ok && !skippedProbeAuthForDisabledExecSecretRef && !redactedProbeCredential) {
    rpcAuthWarning = undefined;
  }
  const health =
    opts.probe && serviceTargetsProbe && loaded && rpc?.ok !== true
      ? await import("./restart-health.js")
          .then(({ inspectGatewayRestart }) =>
            inspectGatewayRestart({
              service,
              port: daemonPort,
              env: serviceEnv,
              probeHosts: resolveGatewayRequiredListenHosts(gateway.bindHost),
            }),
          )
          .catch(() => undefined)
      : undefined;
  const gatewayVersion = opts.probe
    ? ((rpc && "server" in rpc ? rpc.server?.version : undefined) ??
      (rpc && "version" in rpc ? rpc.version : undefined) ??
      null)
    : undefined;

  let lastError: string | undefined;
  if (
    shouldInspectLocalGateway &&
    loaded &&
    portStatus &&
    (portStatus.status !== "busy" || rpc?.ok === false)
  ) {
    lastError = (await readLastGatewayErrorLine(mergedDaemonEnv)) ?? undefined;
  }

  // Plugin version drift detection. Status compares with the running Gateway;
  // Doctor can request the installed service version that a restart will load.
  // Reading records with the merged daemon environment inspects the managed service's
  // profile/state dir, so remote/explicit URL probes need remote-owned
  // diagnostics instead.
  // Status omits unreadable advisory data; Doctor reports restart readiness as unresolved.
  // Registry repair lookups belong to deep-status and Doctor command owners;
  // readiness, support, and triage must not wait for the public registry.
  let pluginVersionDrift: PluginVersionDriftReport | undefined;
  let pluginVersionRestartReadiness: PluginVersionRestartReadiness | undefined;
  if (shouldInspectLocalGateway) {
    const loadInstallRecords = () =>
      loadInstalledPluginIndexInstallRecords({
        env: mergedDaemonEnv,
      });
    try {
      if (opts.pluginVersionTarget === "restart") {
        const runningGatewayVersion = gatewayVersion ?? undefined;
        if (!useNativeServiceTargetContext || (!targetServiceCommand && !loaded)) {
          // Only the authoritative loaded native service can define restart readiness.
        } else {
          const installRecords = await loadInstallRecords();
          if (hasOfficialPluginVersionCandidates({ installRecords, config: daemonCfg })) {
            if (!targetServiceCommand) {
              pluginVersionRestartReadiness = {
                status: "unresolved",
                reason:
                  "Gateway service command is unavailable, so the post-restart OpenClaw version is unknown.",
                ...(runningGatewayVersion ? { runningGatewayVersion } : {}),
              };
            } else {
              const layout = await summarizeGatewayServiceLayout(targetServiceCommand);
              if (!layout?.packageVersion) {
                pluginVersionRestartReadiness = {
                  status: "unresolved",
                  reason:
                    "Gateway service package version is unavailable, so the post-restart OpenClaw version is unknown.",
                  ...(runningGatewayVersion ? { runningGatewayVersion } : {}),
                };
              } else {
                const report = detectPluginVersionDrift({
                  gatewayVersion: layout.packageVersion,
                  installRecords,
                  config: daemonCfg,
                });
                pluginVersionRestartReadiness = {
                  status: "resolved",
                  report,
                  ...(runningGatewayVersion ? { runningGatewayVersion } : {}),
                };
              }
            }
          }
        }
      } else {
        const installRecords = await loadInstallRecords();
        pluginVersionDrift = detectPluginVersionDrift({
          gatewayVersion: gatewayVersion ?? VERSION,
          installRecords,
          config: daemonCfg,
        });
      }
    } catch {
      if (opts.pluginVersionTarget === "restart") {
        pluginVersionRestartReadiness = {
          status: "unresolved",
          reason:
            "Plugin restart readiness could not be inspected, so post-restart compatibility is unknown.",
          ...(gatewayVersion ? { runningGatewayVersion: gatewayVersion } : {}),
        };
      } else {
        pluginVersionDrift = undefined;
      }
    }
  }

  const hostDesktop = await (
    await import("../../gateway/desktop/host-source.js")
  ).inspectHostDesktop({ config: daemonCfg.desktop?.host });
  const targetRole: "target" | "diagnostic-only" = serviceTargetsProbe
    ? "target"
    : "diagnostic-only";

  const projection = await projectDaemonRuntimeStatus({
    deep: opts.deep,
    service,
    state: serviceState,
  });

  return {
    cli: projection.cli,
    logFile: await resolveConfiguredLogFilePath(cliCfg),
    service: {
      inspectionReason: serviceState.inspectionReason,
      label: formatServiceLabel(service.label, runtime),
      ...(serviceState.systemdInstallation
        ? { systemdInstallation: serviceState.systemdInstallation }
        : {}),
      loaded: loadState.status === "unknown" ? null : loaded,
      loadState,
      loadedText: service.loadedText,
      notLoadedText: service.notLoadedText,
      targetRole,
      command,
      ...projection.runtimeIntent,
      ...(serviceLayout ? { layout: serviceLayout } : {}),
      ...(installationDrift
        ? {
            installationDrift: formatGatewayServiceInstallationDrift(
              installationDrift,
              process.env,
              { command },
            ),
          }
        : {}),
      runtime: runtime?.inspectionFailure
        ? {
            ...runtime,
            detail: `${runtime.detail}; retry with openclaw gateway status --deep`,
          }
        : runtime,
      configAudit,
      ...(command
        ? {
            gatewayHeap: inspectGatewayHeapLimit(
              command.environment?.NODE_OPTIONS,
              command.programArguments,
            ),
          }
        : {}),
      ...(restartHandoff ? { restartHandoff } : {}),
      ...launchdDiagnostics,
    },
    config: {
      cli: cliConfigSummary,
      daemon: daemonConfigSummary,
      ...(configMismatch ? { mismatch: true } : {}),
    },
    gateway: {
      ...gateway,
      ...crashHistory,
      ...(lastShutdown ? { lastShutdown } : {}),
      ...(duelingScopesWarning ? { duelingScopesWarning } : {}),
      ...(windowsFirewall?.applies ? { windowsFirewall } : {}),
      ...(opts.probe
        ? {
            version: gatewayVersion,
          }
        : {}),
    },
    hostDesktop: hostDesktop.status,
    port: portStatus,
    ...(portCliStatus ? { portCli: portCliStatus } : {}),
    ...(establishedClients ? { connections: establishedClients } : {}),
    lastError,
    ...(rpc
      ? {
          rpc: {
            ...rpc,
            url: gateway.probeUrl,
            ...(rpcAuthWarning ? { authWarning: rpcAuthWarning } : {}),
          },
        }
      : {}),
    ...(health
      ? {
          health: {
            healthy: health.healthy,
            staleGatewayPids: health.staleGatewayPids,
          },
        }
      : {}),
    extraServices,
    ...(pluginVersionDrift ? { pluginVersionDrift } : {}),
    ...(pluginVersionRestartReadiness ? { pluginVersionRestartReadiness } : {}),
  };
}

type GatheredDaemonStatus = Awaited<ReturnType<typeof gatherDaemonStatusImpl>>;
type GatheredDaemonService = GatheredDaemonStatus["service"];
type GatheredDaemonRpc = NonNullable<GatheredDaemonStatus["rpc"]>;
type UnionKeys<Value> = Value extends Value ? keyof Value : never;
type UnionValue<Value, Key extends PropertyKey> = Value extends Value
  ? Key extends keyof Value
    ? Value[Key]
    : never
  : never;
type RequiredDaemonServiceField = "label" | "loaded" | "loadState" | "loadedText" | "notLoadedText";
type CompatibleDaemonRpcValue<Key extends PropertyKey> = Key extends "server" | "auth"
  ? Partial<NonNullable<UnionValue<GatheredDaemonRpc, Key>>>
  : Key extends "capability"
    ? string
    : UnionValue<GatheredDaemonRpc, Key>;

export type DaemonStatus = Partial<
  Omit<GatheredDaemonStatus, "service" | "extraServices" | "config" | "rpc">
> & {
  service: Pick<GatheredDaemonService, RequiredDaemonServiceField> &
    Partial<Omit<GatheredDaemonService, RequiredDaemonServiceField>>;
  extraServices: GatheredDaemonStatus["extraServices"];
  config?: Pick<NonNullable<GatheredDaemonStatus["config"]>, "cli"> &
    Partial<Omit<NonNullable<GatheredDaemonStatus["config"]>, "cli">>;
  rpc?: { ok: GatheredDaemonRpc["ok"] } & {
    [Key in Exclude<UnionKeys<GatheredDaemonRpc>, "ok">]?: CompatibleDaemonRpcValue<Key>;
  };
};

export async function gatherDaemonStatus(
  opts: Parameters<typeof gatherDaemonStatusImpl>[0],
): Promise<DaemonStatus> {
  return gatherDaemonStatusImpl(opts);
}
