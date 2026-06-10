import { listPersistedRuntimeToolSchemaQuarantines } from "../agents/tool-schema-quarantine-health.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
// Runtime plugin health collection is isolated from pure status formatting so
// ordinary status tests do not eagerly load plugin registry internals.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listContextEngineQuarantines } from "../context-engine/registry.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import {
  isChannelPluginFailureDiagnostic,
  mergeStatusPluginHealthSnapshots,
} from "./status-plugin-health.js";
import type {
  ChannelPluginFailureRecord,
  PluginCompatibilityHealthNotice,
  PluginDiagnosticRecord,
  PluginHealthRecord,
  RuntimeToolQuarantineRecord,
  StatusPluginHealthSnapshot,
} from "./status-plugin-health.js";

function normalizeSnapshotPlugin(plugin: PluginHealthRecord): PluginHealthRecord {
  const normalized: PluginHealthRecord = { id: plugin.id };
  if (plugin.status !== undefined) {
    normalized.status = plugin.status;
  }
  if (plugin.enabled !== undefined) {
    normalized.enabled = plugin.enabled;
  }
  if (plugin.error !== undefined) {
    normalized.error = plugin.error;
  }
  if (plugin.dependencyStatus !== undefined) {
    normalized.dependencyStatus = plugin.dependencyStatus;
  }
  if (plugin.failurePhase !== undefined) {
    normalized.failurePhase = plugin.failurePhase;
  }
  return normalized;
}

function normalizeDiagnostic(diagnostic: PluginDiagnosticRecord): PluginDiagnosticRecord {
  const normalized: PluginDiagnosticRecord = {
    level: diagnostic.level,
    message: diagnostic.message,
  };
  if (diagnostic.pluginId) {
    normalized.pluginId = diagnostic.pluginId;
  }
  return normalized;
}

function normalizeCompatibilityNotice(
  notice: PluginCompatibilityHealthNotice,
): PluginCompatibilityHealthNotice {
  return {
    pluginId: notice.pluginId,
    severity: notice.severity,
    message: notice.message,
    ...(notice.code ? { code: notice.code } : {}),
  };
}

function mergeDiagnostics(
  left: readonly PluginDiagnosticRecord[],
  right: readonly PluginDiagnosticRecord[],
): PluginDiagnosticRecord[] {
  const merged = new Map<string, PluginDiagnosticRecord>();
  for (const diagnostic of [...left, ...right]) {
    merged.set(
      JSON.stringify([diagnostic.level, diagnostic.pluginId ?? "", diagnostic.message]),
      diagnostic,
    );
  }
  return [...merged.values()];
}

function collectChannelPluginFailures(params: {
  config?: OpenClawConfig;
  diagnostics?: readonly PluginDiagnosticRecord[];
  workspaceDir?: string;
  includeSetupFallbackPlugins?: boolean;
}): ChannelPluginFailureRecord[] {
  const diagnosticFailures = (params.diagnostics ?? [])
    .filter(isChannelPluginFailureDiagnostic)
    .map((diagnostic) => {
      const failure: ChannelPluginFailureRecord = {
        channelId: diagnostic.pluginId ?? "unknown",
        message: diagnostic.message,
        source: "diagnostic",
      };
      if (diagnostic.pluginId) {
        failure.pluginId = diagnostic.pluginId;
      }
      return failure;
    });
  const dedupeConcreteFailures = (
    failures: readonly ChannelPluginFailureRecord[],
  ): ChannelPluginFailureRecord[] => {
    const byFailure = new Map<string, ChannelPluginFailureRecord>();
    for (const failure of failures) {
      const key = JSON.stringify([failure.channelId, failure.pluginId ?? "", failure.message]);
      if (!byFailure.has(key)) {
        byFailure.set(key, failure);
      }
    }
    return [...byFailure.values()];
  };
  if (!params.config) {
    return dedupeConcreteFailures(diagnosticFailures);
  }
  try {
    const resolution = resolveReadOnlyChannelPluginsForConfig(params.config, {
      workspaceDir: params.workspaceDir,
      activationSourceConfig: params.config,
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: params.includeSetupFallbackPlugins === true,
    });
    const loadFailures = resolution.loadFailures.map((failure) => ({
      channelId: failure.channelId,
      pluginId: failure.pluginId,
      message: failure.message,
      ...(failure.source ? { source: failure.source } : {}),
    }));
    const concreteFailures = dedupeConcreteFailures([...diagnosticFailures, ...loadFailures]);
    const failedChannelIds = new Set(concreteFailures.map((failure) => failure.channelId));
    return [
      ...concreteFailures,
      ...resolution.missingConfiguredChannelIds
        .filter((channelId) => !failedChannelIds.has(channelId))
        .map((channelId) => ({
          channelId,
          message: "configured channel plugin is missing or unavailable",
        })),
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      ...diagnosticFailures,
      {
        channelId: "unknown",
        message: `failed to inspect configured channel plugins: ${message}`,
      },
    ];
  }
}

function parsePluginOwner(owner: string | undefined): string | undefined {
  const prefix = "plugin:";
  if (!owner?.startsWith(prefix)) {
    return undefined;
  }
  const pluginId = owner.slice(prefix.length).trim();
  return pluginId.length > 0 ? pluginId : undefined;
}

function filterRuntimeToolQuarantinesForRegistry(params: {
  quarantines: readonly RuntimeToolQuarantineRecord[];
  plugins: readonly PluginHealthRecord[];
}): RuntimeToolQuarantineRecord[] {
  const loadedPluginIds = new Set(
    params.plugins
      .filter((plugin) => plugin.enabled !== false && plugin.status !== "disabled")
      .map((plugin) => plugin.id),
  );
  return params.quarantines.filter((quarantine) => {
    const pluginId = parsePluginOwner(quarantine.owner);
    return !pluginId || loadedPluginIds.has(pluginId);
  });
}

export function collectRuntimePluginHealthSnapshot(
  params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
  } = {},
): StatusPluginHealthSnapshot {
  const registry = getActiveRuntimePluginRegistry();
  const diagnostics = (registry?.diagnostics ?? []).map(normalizeDiagnostic);
  const plugins = (registry?.plugins ?? []).map(normalizeSnapshotPlugin);
  return {
    plugins,
    diagnostics,
    contextEngineQuarantines: listContextEngineQuarantines(),
    runtimeToolQuarantines: filterRuntimeToolQuarantinesForRegistry({
      quarantines: listPersistedRuntimeToolSchemaQuarantines(),
      plugins,
    }),
    channelPluginFailures: collectChannelPluginFailures({
      ...params,
      diagnostics,
      includeSetupFallbackPlugins: true,
    }),
  };
}

export async function collectInstalledPluginHealthSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<StatusPluginHealthSnapshot> {
  const runtimeRegistry = getActiveRuntimePluginRegistry();
  const [{ buildPluginCompatibilityNotices, buildPluginSnapshotReport }, runtime] =
    await Promise.all([
      import("../plugins/status.js"),
      Promise.resolve(collectRuntimePluginHealthSnapshot()),
    ]);
  const report = buildPluginSnapshotReport({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const installedDiagnostics = report.diagnostics.map(normalizeDiagnostic);
  const runtimeDiagnostics = (runtimeRegistry?.diagnostics ?? []).map(normalizeDiagnostic);
  const diagnostics = mergeDiagnostics(installedDiagnostics, runtimeDiagnostics);
  const installedChannelPluginFailures = collectChannelPluginFailures({
    config: params.config,
    diagnostics,
    workspaceDir: params.workspaceDir,
    includeSetupFallbackPlugins: true,
  });
  const runtimeCompatibilityNotices = runtimeRegistry
    ? buildPluginCompatibilityNotices({
        config: params.config,
        workspaceDir: params.workspaceDir,
        report: runtimeRegistry,
      }).map(normalizeCompatibilityNotice)
    : [];
  return mergeStatusPluginHealthSnapshots(
    {
      plugins: report.plugins.map(normalizeSnapshotPlugin),
      diagnostics: installedDiagnostics,
      contextEngineQuarantines: [],
      channelPluginFailures: installedChannelPluginFailures,
      compatibilityNotices: buildPluginCompatibilityNotices({
        config: params.config,
        workspaceDir: params.workspaceDir,
        report,
      }).map(normalizeCompatibilityNotice),
    },
    {
      plugins: (runtimeRegistry?.plugins ?? []).map(normalizeSnapshotPlugin),
      diagnostics: runtimeDiagnostics,
      contextEngineQuarantines: runtime.contextEngineQuarantines,
      runtimeToolQuarantines: runtime.runtimeToolQuarantines,
      channelPluginFailures: runtime.channelPluginFailures,
      compatibilityNotices: runtimeCompatibilityNotices,
    },
  );
}
