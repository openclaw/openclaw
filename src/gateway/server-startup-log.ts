// Gateway startup logging helpers.
// Produces the compact ready banner with resolved model and safety state.
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import chalk from "chalk";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { formatFastModeValue, resolveFastModeState } from "../agents/fast-mode.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import {
  buildConfiguredModelCatalog,
  resolveConfiguredModelRef,
} from "../agents/model-selection-shared.js";
import { resolveConfiguredThinkingDefaultCore } from "../agents/model-thinking-default-core.js";
import { resolveThinkingDefault } from "../agents/model-thinking-default.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import { getTrackedWorkerLifecycleSnapshot } from "../infra/worker-cpu.js";
import { getWorkerComputeCapacity } from "../infra/worker-task-capacity.js";
import { getResolvedLoggerSettings } from "../logging.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot } from "../security/dangerous-config-flags-current.js";

/** Emit startup summary lines after Gateway bind and plugin loading complete. */
export async function logGatewayStartup(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRecords: readonly PluginManifestRecord[];
  bindHost: string;
  bindHosts?: string[];
  port: number;
  loadedPluginIds: readonly string[];
  startupStartedAt?: number;
  tlsEnabled?: boolean;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string) => void };
  isNixMode: boolean;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    agentId: tryResolveAmbientOwnerAgentId(params.cfg),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const agentModelLog = formatAgentModelStartupLogLine({
    cfg: params.cfg,
    provider: agentProvider,
    model: agentModel,
  });
  params.log.info(agentModelLog.message, {
    consoleMessage: agentModelLog.consoleMessage,
  });
  const startupDurationMs =
    typeof params.startupStartedAt === "number" ? Date.now() - params.startupStartedAt : null;
  const startupDurationLabel =
    startupDurationMs == null ? null : `${(startupDurationMs / 1000).toFixed(1)}s`;
  params.log.info(
    `http server listening (${formatReadyDetails(params.loadedPluginIds, startupDurationLabel)})`,
  );
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  const sqliteLibrary = ensureSqliteLibrarySelected();
  params.log.info(
    `native runtime: ${JSON.stringify({
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      bun: process.versions.bun,
      v8: process.versions.v8,
      uv: process.versions.uv,
      openssl: process.versions.openssl,
      sqlite: sqliteLibrary.source === "runtime" ? process.versions.sqlite : sqliteLibrary.version,
    })}`,
  );
  params.log.info(
    `worker startup state: ${JSON.stringify({
      ...getTrackedWorkerLifecycleSnapshot(),
      compute: getWorkerComputeCapacity().getSnapshot(),
    })}`,
  );
  if (sqliteLibrary.source !== "runtime") {
    params.log.info(
      `SQLite: using ${sanitizeForLog(sqliteLibrary.path)} (${sqliteLibrary.version}, extension loading enabled)`,
    );
  } else if (sqliteLibrary.ignoredOverride) {
    params.log.warn(`SQLite: ${sqliteLibrary.ignoredOverride}; override ignored`);
  }
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }

  for (const warning of await collectConfiguredChannelStartupWarnings({
    cfg: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
    ambientEnvTriggers: params.ambientEnvTriggers,
    env: params.env,
    manifestRecords: params.manifestRecords,
  })) {
    params.log.warn(warning);
  }

  const enabledDangerousFlags =
    collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot(params.cfg) ??
    (await import("../security/dangerous-config-flags.js")).collectEnabledInsecureOrDangerousFlags(
      params.cfg,
    );
  if (enabledDangerousFlags.length > 0) {
    const warning =
      `security warning: dangerous config flags enabled: ${enabledDangerousFlags.join(", ")}. ` +
      "Run `openclaw security audit`.";
    params.log.warn(warning);
  }
}

/** Format the startup model line from the model ref already selected by the caller. */
export function formatAgentModelStartupLogLine(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): { message: string; consoleMessage: string } {
  const modelRef = `${params.provider}/${params.model}`;
  const modelDetails = formatAgentModelStartupDetails(params);
  return {
    message: `agent model: ${modelRef} (${modelDetails})`,
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)} (${modelDetails})`,
  };
}

/** True when a configured catalog entry disables reasoning for the startup model. */
function isConfiguredReasoningDisabled(params: {
  catalog: readonly ModelCatalogEntry[];
  provider: string;
  model: string;
}): boolean {
  return params.catalog.some(
    (entry) =>
      entry.provider === params.provider && entry.id === params.model && entry.reasoning === false,
  );
}

/** Format model thinking and fast-mode details for the Gateway startup banner. */
export function formatAgentModelStartupDetails(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): string {
  const soleAgentId = tryResolveAmbientOwnerAgentId(params.cfg);
  let thinking = resolveConfiguredThinkingDefaultCore({ ...params, agentId: soleAgentId });
  if (thinking === undefined) {
    const configuredCatalog = buildConfiguredModelCatalog({ cfg: params.cfg });
    // Catalog reasoning=false is authoritative; avoid loading provider policy artifacts
    // only to discard their default below.
    if (
      isConfiguredReasoningDisabled({
        catalog: configuredCatalog,
        provider: params.provider,
        model: params.model,
      })
    ) {
      thinking = "off";
    } else {
      const resolvedThinking = resolveThinkingDefault({
        cfg: params.cfg,
        agentId: soleAgentId,
        provider: params.provider,
        model: params.model,
        catalog: configuredCatalog,
      });
      thinking = resolvedThinking === "off" ? "medium" : resolvedThinking;
    }
  }
  const fast = resolveFastModeState({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    agentId: soleAgentId,
  });

  return `thinking=${thinking}, fast=${formatFastModeValue(fast.mode)}`;
}

async function collectConfiguredChannelStartupWarnings(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  env: NodeJS.ProcessEnv;
  manifestRecords: readonly PluginManifestRecord[];
}): Promise<string[]> {
  const [blockerModule, presencePolicyModule] = await Promise.all([
    import("../commands/doctor/shared/channel-plugin-blockers.js"),
    import("../plugins/channel-presence-policy.js"),
  ]);
  const hits = blockerModule.scanConfiguredChannelPluginBlockers(
    params.cfg,
    params.env,
    params.activationSourceConfig,
    {
      manifestRecords: params.manifestRecords,
      ambientEnvTriggers: params.ambientEnvTriggers,
    },
  );
  const blockerWarnings = blockerModule
    .collectConfiguredChannelPluginBlockerWarnings(hits)
    .map((warning) => `configured channel warning: ${warning.replace(/^[-]\s*/u, "")}`);
  const missingOwnerWarnings = presencePolicyModule
    .resolveConfiguredChannelPresencePolicy({
      config: params.cfg,
      activationSourceConfig: params.activationSourceConfig,
      env: params.env,
      includePersistedAuthState: false,
      ambientEnvTriggers: params.ambientEnvTriggers,
      manifestRecords: params.manifestRecords,
    })
    .filter((entry) => !entry.effective && entry.blockedReasons.includes("no-channel-owner"))
    .map(formatConfiguredChannelMissingOwnerStartupWarning);
  const suppressedAmbientChannelIds =
    params.ambientEnvTriggers === "suppress"
      ? presencePolicyModule.listAmbientOnlyConfiguredChannelIds({
          config: params.cfg,
          activationSourceConfig: params.activationSourceConfig,
          env: params.env,
          includePersistedAuthState: false,
          manifestRecords: params.manifestRecords,
        })
      : [];
  const suppressionWarning =
    suppressedAmbientChannelIds.length > 0
      ? [formatSuppressedAmbientChannelsStartupWarning(suppressedAmbientChannelIds)]
      : [];
  return [...suppressionWarning, ...blockerWarnings, ...missingOwnerWarnings];
}

function formatSuppressedAmbientChannelsStartupWarning(channelIds: readonly string[]): string {
  const safeChannelIds = normalizeSortedUniqueStringEntries(channelIds).map((channelId) =>
    sanitizeForLog(channelId),
  );
  return (
    `gateway suppressed ambient channel auto-configuration for ${safeChannelIds.length} ` +
    `${safeChannelIds.length === 1 ? "channel" : "channels"}: ${safeChannelIds.join(", ")}. ` +
    "Configure channels.<id> (openclaw channels add <id>) to enable the channel, or pass " +
    "--ambient-channels to allow ambient env credentials."
  );
}

function formatConfiguredChannelMissingOwnerStartupWarning(entry: {
  channelId: string;
  blockedReasons: readonly string[];
}): string {
  const channelId = sanitizeForLog(entry.channelId);
  const reasons = normalizeSortedUniqueStringEntries(entry.blockedReasons).join(", ");
  return (
    `configured channel warning: channels.${channelId} is configured but no channel plugin ` +
    `is installed or loadable (${reasons}). Run \`openclaw doctor --fix\` or install the ` +
    "channel plugin before relying on this channel."
  );
}

/** Format plugin count/list and optional startup duration for the ready log line. */
function formatReadyDetails(
  loadedPluginIds: readonly string[],
  startupDurationLabel: string | null,
) {
  const pluginIds = normalizeSortedUniqueStringEntries(loadedPluginIds);
  const pluginSummary =
    pluginIds.length === 0
      ? "0 plugins"
      : `${pluginIds.length} ${pluginIds.length === 1 ? "plugin" : "plugins"}: ${pluginIds.join(", ")}`;

  if (!startupDurationLabel) {
    return pluginSummary;
  }
  return pluginIds.length === 0
    ? `${pluginSummary}, ${startupDurationLabel}`
    : `${pluginSummary}; ${startupDurationLabel}`;
}
