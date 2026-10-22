// It collects config, update, gateway, channel, and local agent state before specialized callers add details.

import { measureCliCommandStartup } from "../cli/command-startup-timing.js";
import type { BestEffortConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayAuthTokenSourceConflict } from "../gateway/auth-token-source-conflict.js";
import type { collectChannelStatusIssues as collectChannelStatusIssuesFn } from "../infra/channels-status-issues.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { applyLoggingConfig } from "../logging/logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { PreparedStatusSessionStores } from "../status/session-stores.js";
import type { StatusSummary } from "../status/summary.js";
import type { buildChannelsTable as buildChannelsTableFn } from "./status-all/channels.js";
import type {
  AgentLocalStatusesResult,
  PreparedStatusLocalSnapshot,
} from "./status.agent-local.js";
import {
  resolveStatusGatewayProbeTimeoutMs,
  type StatusGatewayProbeBudget,
} from "./status.gateway-probe-budget.js";
import {
  buildColdStartStatusSummary,
  createStatusScanCoreBootstrap,
} from "./status.scan.bootstrap-shared.js";
import type { GatewayProbeSnapshot } from "./status.scan.shared.js";

export type StatusScanOverviewResult = {
  env?: NodeJS.ProcessEnv;
  skipColdStartNetworkChecks: boolean;
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  configDiagnostics: BestEffortConfigSnapshot["configDiagnostics"];
  secretDiagnostics: string[];
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  advertisedControlUiLinks?: { httpUrl: string; wsUrl: string };
  update: UpdateCheckResult;
  gatewaySnapshot: GatewayProbeSnapshot;
  runtimeDegradation:
    | (Pick<
        StatusSummary,
        | "degradedSecretOwners"
        | "degradedPlugins"
        | "startupMigrationWarning"
        | "modelReasoningWarning"
        | "installationReplacementWarning"
        | "utilityModelWarnings"
        | "childRuntime"
        | "secretEgressProxy"
        | "pluginReload"
        | "sqliteWal"
        | "databaseStores"
      > &
        Partial<Pick<StatusSummary, "heartbeat">>)
    | null;
  channelsStatus: unknown;
  channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
  channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
  agentStatus: AgentLocalStatusesResult | PreparedStatusLocalSnapshot;
  sessionStores?: PreparedStatusSessionStores;
};

/** Collects the common status scan data shared by text, JSON, and status-all commands. */
export async function collectStatusScanOverview(params: {
  env?: NodeJS.ProcessEnv;
  commandName: string;
  opts: StatusGatewayProbeBudget & { all?: boolean; deep?: boolean };
  showSecrets: boolean;
  runtime?: RuntimeEnv;
  allowMissingConfigFastPath?: boolean;
  fetchGitUpdate?: boolean;
  includeRegistryUpdate?: boolean;
  resolveHasConfiguredChannels?: (
    cfg: OpenClawConfig,
    sourceConfig: OpenClawConfig,
  ) => boolean | Promise<boolean>;
  includeChannelsData?: boolean;
  includeLiveChannelStatus?: boolean;
  includeLocalStatusRpcFallback?: boolean;
  gatewaySnapshot?: GatewayProbeSnapshot;
  includeChannelSetupRuntimeFallback?: boolean;
  useGatewayCallOverridesForChannelsStatus?: boolean;
  includeAdvertisedControlUiLinks?: boolean;
  progress?: {
    setLabel(label: string): void;
    tick(): void;
  };
  labels?: {
    loadingConfig?: string;
    checkingTailscale?: string;
    checkingForUpdates?: string;
    resolvingAgents?: string;
    probingGateway?: string;
    queryingChannelStatus?: string;
    summarizingChannels?: string;
  };
}): Promise<StatusScanOverviewResult> {
  const env = params.env ?? process.env;
  const setProgressLabel = (key: keyof NonNullable<typeof params.labels>) => {
    const label = params.labels?.[key];
    if (label) {
      params.progress?.setLabel(label);
    }
  };
  setProgressLabel("loadingConfig");
  const { snapshot } = await measureCliCommandStartup(
    "status.config",
    async () =>
      (await import("../cli/command-config-snapshot.js")).readCommandConfigSnapshot({
        observe: false,
        skipPluginValidation: true,
      }),
    { env },
  );
  const testRuntime =
    env.VITEST === "true" || env.VITEST_POOL_ID !== undefined || env.NODE_ENV === "test";
  const coldStart = !snapshot.exists && !(params.allowMissingConfigFastPath && testRuntime);
  const skipMissingConfig = coldStart && params.allowMissingConfigFastPath === true;
  const sourceConfig = skipMissingConfig ? {} : snapshot.sourceConfig;
  const loadedConfig = skipMissingConfig ? {} : snapshot.runtimeConfig;
  const configDiagnostics =
    skipMissingConfig || snapshot.valid ? null : { path: snapshot.path, issues: snapshot.issues };
  // Secret resolution precedes probing, and each request uses the scan's existing budget.
  const { resolvedConfig: cfg, diagnostics } = skipMissingConfig
    ? { resolvedConfig: loadedConfig, diagnostics: [] }
    : await measureCliCommandStartup(
        "status.secrets",
        () =>
          import("../cli/command-config-resolution.js").then(
            async ({ resolveCommandConfigWithSecrets }) =>
              resolveCommandConfigWithSecrets({
                config: loadedConfig,
                commandName: params.commandName,
                targetIds: (
                  await import("../cli/command-secret-targets.js")
                ).getStatusCommandSecretTargetIds(loadedConfig, env),
                mode: "read_only_status",
                gatewaySecretResolveTimeoutMs: resolveStatusGatewayProbeTimeoutMs(params.opts),
                ...(params.runtime ? { runtime: params.runtime } : {}),
              }),
          ),
        { env },
      );
  const tokenConflict = resolveGatewayAuthTokenSourceConflict({ cfg: sourceConfig, env });
  const secretDiagnostics = tokenConflict
    ? [...diagnostics, tokenConflict.diagnostic]
    : diagnostics;
  applyLoggingConfig(cfg.logging);
  params.progress?.tick();
  const hasConfiguredChannels = params.resolveHasConfiguredChannels
    ? await params.resolveHasConfiguredChannels(cfg, sourceConfig)
    : await (async () => {
        const { hasConfiguredChannelsForReadOnlyScope } =
          await import("../plugins/channel-plugin-ids.js");
        return hasConfiguredChannelsForReadOnlyScope({
          config: cfg,
          activationSourceConfig: sourceConfig,
        });
      })();
  const osSummary = resolveOsSummary();
  let sessionStores: PreparedStatusSessionStores | undefined;
  const bootstrap = await createStatusScanCoreBootstrap<
    AgentLocalStatusesResult | PreparedStatusLocalSnapshot
  >({
    coldStart,
    cfg,
    configPath: snapshot.path,
    env,
    hasConfiguredChannels,
    opts: params.opts,
    fetchGitUpdate: params.fetchGitUpdate,
    includeRegistryUpdate: params.includeRegistryUpdate,
    includeLocalStatusRpcFallback: params.includeLocalStatusRpcFallback,
    gatewaySnapshot: params.gatewaySnapshot,
    onGatewayProgress: params.progress
      ? (phase) => {
          const message = `Gateway still starting (phase ${phase})`;
          params.progress?.setLabel(message);
          if (!process.stderr.isTTY) {
            (params.runtime ?? defaultRuntime).log(message);
          }
        }
      : undefined,
    getAgentLocalStatuses: async (bootstrapCfg) =>
      await measureCliCommandStartup(
        "status.local-agents",
        () =>
          import("./status.agent-local.js").then(async ({ collectStatusLocalSnapshot }) => {
            const local = await collectStatusLocalSnapshot(bootstrapCfg);
            sessionStores = local.sessionStores;
            return local;
          }),
        { config: cfg, env },
      ),
  });

  setProgressLabel("checkingTailscale");
  const tailscaleDns = await bootstrap.tailscaleDnsPromise;
  params.progress?.tick();

  setProgressLabel("checkingForUpdates");
  const update = await bootstrap.updatePromise;
  params.progress?.tick();

  setProgressLabel("resolvingAgents");
  const localSnapshot = await bootstrap.agentStatusPromise;
  params.progress?.tick();

  setProgressLabel("probingGateway");
  const gatewaySnapshot = await bootstrap.gatewayProbePromise;
  params.progress?.tick();
  let runtimeDegradation: StatusScanOverviewResult["runtimeDegradation"] = null;
  if (gatewaySnapshot.gatewayReachable) {
    const status =
      gatewaySnapshot.gatewayProbe?.status ??
      (resolveStatusGatewayProbeTimeoutMs(params.opts) > 0
        ? await measureCliCommandStartup(
            "status.gateway-degradation",
            () =>
              import("../gateway/call.js").then(({ callGateway }) =>
                callGateway<StatusSummary>({
                  config: cfg,
                  configPath: snapshot.path,
                  method: "status",
                  params: { includeChannelSummary: false, includeCliProjection: true },
                  timeoutMs: Math.min(5000, resolveStatusGatewayProbeTimeoutMs(params.opts)),
                  ...gatewaySnapshot.gatewayCallOverrides,
                }).catch(() => null),
              ),
            { config: cfg, env },
          )
        : null);
    runtimeDegradation = status
      ? {
          degradedSecretOwners: status.degradedSecretOwners ?? [],
          degradedPlugins: status.degradedPlugins ?? [],
          startupMigrationWarning: status.startupMigrationWarning,
          modelReasoningWarning: status.modelReasoningWarning,
          installationReplacementWarning: status.installationReplacementWarning,
          utilityModelWarnings: status.utilityModelWarnings,
          ...(params.opts.deep && status.childRuntime ? { childRuntime: status.childRuntime } : {}),
          secretEgressProxy: status.secretEgressProxy,
          pluginReload: status.pluginReload,
          sqliteWal: status.sqliteWal,
          ...(status.databaseStores ? { databaseStores: status.databaseStores } : {}),
          // The Gateway owns route readiness; CLI channel runtimes stay unloaded.
          ...(status.heartbeat ? { heartbeat: status.heartbeat } : {}),
        }
      : null;
  }

  const tailscaleHttpsUrl = await bootstrap.resolveTailscaleHttpsUrl();
  const advertisedControlUiLinks =
    params.includeAdvertisedControlUiLinks === true && cfg.gateway?.controlUi?.enabled !== false
      ? await import("../gateway/control-ui-links.js").then(
          async ({ resolveAdvertisedControlUiLinks }) =>
            resolveAdvertisedControlUiLinks({
              port: (await import("../config/config.js")).resolveGatewayPort(cfg),
              bind: cfg.gateway?.bind,
              customBindHost: cfg.gateway?.customBindHost,
              basePath: cfg.gateway?.controlUi?.basePath,
              tlsEnabled: cfg.gateway?.tls?.enabled === true,
            }),
        )
      : undefined;
  // Some JSON/fast scans only need gateway/config fields; keep channel output structurally empty.
  let channelsStatus: Record<string, unknown> | null = null;
  let channelIssues: StatusScanOverviewResult["channelIssues"] = [];
  let channels: StatusScanOverviewResult["channels"] = { rows: [], details: [] };
  if (params.includeChannelsData !== false) {
    setProgressLabel("queryingChannelStatus");
    if (params.includeLiveChannelStatus !== false) {
      const configPath = snapshot.path;
      const gatewayReachable = gatewaySnapshot.gatewayReachable;
      const opts = params.opts;
      const gatewayCallOverrides = gatewaySnapshot.gatewayCallOverrides;
      const useGatewayCallOverrides = params.useGatewayCallOverridesForChannelsStatus;
      // Avoid a second gateway call after probe failure; channel tables can still summarize local config.
      if (gatewayReachable) {
        const { callGateway } = await import("../gateway/call.js");
        const timeoutMs = resolveStatusGatewayProbeTimeoutMs(opts);
        if (timeoutMs !== 0) {
          channelsStatus = await callGateway({
            config: cfg,
            configPath,
            method: "channels.status",
            params: {
              probe: false,
              timeoutMs: Math.min(8000, timeoutMs),
            },
            timeoutMs,
            ...(useGatewayCallOverrides === true ? (gatewayCallOverrides ?? {}) : {}),
          }).catch(() => null);
        }
      }
    }
    params.progress?.tick();
    // Runtime channel helpers stay lazy because JSON fast paths can skip channel data entirely.
    const { collectChannelStatusIssues, buildChannelsTable } =
      await import("./status.scan.runtime.js");
    channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
    setProgressLabel("summarizingChannels");
    channels = await buildChannelsTable(cfg, {
      showSecrets: params.showSecrets,
      sourceConfig,
      includeSetupFallbackPlugins: params.includeChannelSetupRuntimeFallback !== false,
      liveChannelStatus: channelsStatus,
    });
    params.progress?.tick();
  }

  return {
    env,
    skipColdStartNetworkChecks: bootstrap.skipColdStartNetworkChecks,
    cfg,
    sourceConfig,
    configDiagnostics,
    secretDiagnostics,
    osSummary,
    tailscaleMode: bootstrap.tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    ...(advertisedControlUiLinks ? { advertisedControlUiLinks } : {}),
    update,
    gatewaySnapshot,
    runtimeDegradation,
    channelsStatus,
    channelIssues,
    channels,
    agentStatus: localSnapshot,
    ...(sessionStores ? { sessionStores } : {}),
  };
}

/** Prepares a local summary while preserving the cold-start fast path. */
export async function prepareStatusSummaryFromOverview(params: {
  overview: Pick<
    StatusScanOverviewResult,
    "skipColdStartNetworkChecks" | "cfg" | "sourceConfig" | "runtimeDegradation" | "sessionStores"
  >;
}) {
  if (params.overview.skipColdStartNetworkChecks) {
    const summary: StatusSummary = buildColdStartStatusSummary();
    return {
      publish: () => ({ summary, sessionStores: undefined }),
    };
  }
  const prepared = await measureCliCommandStartup(
    "status.summary",
    () =>
      import("../status/summary.js").then(({ prepareStatusSummary }) =>
        prepareStatusSummary({
          config: params.overview.cfg,
          sourceConfig: params.overview.sourceConfig,
          // CLI scans own channel output separately; skip duplicate plugin discovery in the summary.
          includeChannelSummary: false,
          ...(params.overview.sessionStores
            ? { sessionStores: params.overview.sessionStores }
            : {}),
        }),
      ),
    { config: params.overview.cfg },
  );
  return {
    publish() {
      const result = prepared.publish();
      return {
        ...result,
        summary: params.overview.runtimeDegradation
          ? { ...result.summary, ...params.overview.runtimeDegradation }
          : result.summary,
      };
    },
  };
}
