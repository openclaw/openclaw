import { listPersistedRuntimeToolSchemaQuarantines } from "../agents/tool-schema-quarantine-health.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
// Runtime plugin health collection is isolated from pure status formatting so
// ordinary status tests do not eagerly load plugin registry internals.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listContextEngineQuarantines } from "../context-engine/registry.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import {
  dedupeChannelPluginFailures,
  dedupePluginDiagnostics,
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

// The normalize* helpers project registry records onto the snapshot types while
// omitting absent fields entirely, so snapshot merges never see explicitly
// undefined values and test fixtures stay minimal.
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
  if (diagnostic.code) {
    normalized.code = diagnostic.code;
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

function collectChannelPluginFailures(params: {
  config?: OpenClawConfig;
  diagnostics?: readonly PluginDiagnosticRecord[];
  workspaceDir?: string;
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
  if (!params.config) {
    return dedupeChannelPluginFailures(diagnosticFailures);
  }
  try {
    const resolution = resolveReadOnlyChannelPluginsForConfig(params.config, {
      workspaceDir: params.workspaceDir,
      activationSourceConfig: params.config,
      includePersistedAuthState: false,
      // Detailed status inspects the full surface, including setup-fallback
      // plugins, so missing-channel detection matches what setup would load.
      includeSetupFallbackPlugins: true,
    });
    const loadFailures = resolution.loadFailures.map((failure) => ({
      channelId: failure.channelId,
      pluginId: failure.pluginId,
      message: failure.message,
      ...(failure.source ? { source: failure.source } : {}),
    }));
    const concreteFailures = dedupeChannelPluginFailures([...diagnosticFailures, ...loadFailures]);
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

// Compact status reads only the active registry and persisted health stores;
// full config-driven channel inspection is reserved for the installed path.
export function collectRuntimePluginHealthSnapshot(): StatusPluginHealthSnapshot {
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
      diagnostics,
    }),
  };
}

export async function collectInstalledPluginHealthSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<StatusPluginHealthSnapshot> {
  const { buildPluginCompatibilityNotices, buildPluginSnapshotReport } =
    await import("../plugins/status.js");
  const runtime = collectRuntimePluginHealthSnapshot();
  const report = buildPluginSnapshotReport({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const installedDiagnostics = report.diagnostics.map(normalizeDiagnostic);
  // Channel failures resolve once against the union of installed and runtime
  // diagnostics so missing-channel entries cannot duplicate concrete failures
  // that only one side observed.
  const channelPluginFailures = collectChannelPluginFailures({
    config: params.config,
    diagnostics: dedupePluginDiagnostics([...installedDiagnostics, ...runtime.diagnostics]),
    workspaceDir: params.workspaceDir,
  });
  const runtimeRegistry = getActiveRuntimePluginRegistry();
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
      channelPluginFailures,
      compatibilityNotices: buildPluginCompatibilityNotices({
        config: params.config,
        workspaceDir: params.workspaceDir,
        report,
      }).map(normalizeCompatibilityNotice),
    },
    { ...runtime, compatibilityNotices: runtimeCompatibilityNotices },
  );
}
