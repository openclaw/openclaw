import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolveOpenClawReleaseCohortVersion } from "../infra/npm-registry-spec.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  resolvePluginVersionDriftRegistryLag,
  resolvePluginVersionDriftUpdateCommand,
  type PluginVersionRestartReadiness,
} from "../plugins/plugin-version-drift.js";
import {
  buildPluginCompatibilityWarnings,
  buildPluginRegistrySnapshotReport,
} from "../plugins/status.js";

const WORKSPACE_STATUS_CHECK_ID = "core/doctor/workspace-status";
const PLUGIN_DIAGNOSTICS_DOCS = "https://docs.openclaw.ai/cli/plugins/inspect-and-diagnose#doctor";

type WorkspacePluginDiagnostic = ReturnType<
  typeof buildPluginRegistrySnapshotReport
>["diagnostics"][number];

function claimPluginDiagnostic(seen: Set<string>, diagnostic: WorkspacePluginDiagnostic): boolean {
  const key = [
    diagnostic.level,
    diagnostic.pluginId ?? "",
    diagnostic.code ?? "",
    diagnostic.errorCode ?? "",
    diagnostic.source ?? "",
    diagnostic.message,
  ]
    .map((value) => `${value.length}:${value}`)
    .join("");
  if (seen.has(key)) {
    return false;
  }
  seen.add(key);
  return true;
}

function pluginVersionReadinessToHealthFindings(
  readiness: PluginVersionRestartReadiness | undefined,
): HealthFinding[] {
  if (!readiness) {
    return [];
  }
  if (readiness.status === "unresolved") {
    return [
      {
        checkId: WORKSPACE_STATUS_CHECK_ID,
        severity: "warning",
        category: "fix-now",
        docsUrl: PLUGIN_DIAGNOSTICS_DOCS,
        message: `Could not check plugin restart readiness: ${readiness.reason}`,
        path: "plugins",
        requirement: "plugin-version-restart-readiness",
        fixHint:
          "Repair the Gateway service installation, then rerun openclaw doctor before restarting.",
      },
    ];
  }
  const { report: drift, runningGatewayVersion } = readiness;
  if (drift.drifts.length === 0) {
    if (
      !runningGatewayVersion ||
      resolveOpenClawReleaseCohortVersion(runningGatewayVersion) ===
        resolveOpenClawReleaseCohortVersion(drift.gatewayVersion)
    ) {
      return [];
    }
    return [
      {
        checkId: WORKSPACE_STATUS_CHECK_ID,
        severity: "warning",
        category: "fix-now",
        docsUrl: PLUGIN_DIAGNOSTICS_DOCS,
        message: `Active official plugins match post-restart OpenClaw ${drift.gatewayVersion}, but the running Gateway is ${runningGatewayVersion}.`,
        path: "plugins",
        requirement: "plugin-version-gateway-restart",
        fixHint: formatCliCommand("openclaw gateway restart"),
      },
    ];
  }
  return drift.drifts.map((entry): HealthFinding => {
    const registryLag = resolvePluginVersionDriftRegistryLag(entry);
    if (registryLag) {
      return {
        checkId: WORKSPACE_STATUS_CHECK_ID,
        severity: "info",
        category: "recommended",
        docsUrl: PLUGIN_DIAGNOSTICS_DOCS,
        message: `Plugin ${entry.pluginId} is ${entry.installedVersion} and its registry publishes no newer release (registry version ${registryLag.registryVersion}), but a Gateway restart will load OpenClaw ${drift.gatewayVersion}.${runningGatewayVersion ? ` The running Gateway is ${runningGatewayVersion}.` : ""} No plugin update can reach ${registryLag.expectedVersion}.`,
        path: `plugins.entries.${entry.pluginId}`,
        target: entry.pluginId,
        requirement: "plugin-version-drift",
        fixHint:
          "No plugin repair is available. Keep the current plugin and check its official registry for a compatible release before changing versions.",
      };
    }
    const updateCommand = resolvePluginVersionDriftUpdateCommand(entry);
    const targetResolution = entry.targetResolution;
    const targetError =
      entry.targetResolution?.status === "unresolved"
        ? entry.targetResolution.error
        : "npm registry target was not resolved";
    return {
      checkId: WORKSPACE_STATUS_CHECK_ID,
      severity: "warning",
      category: "fix-now",
      docsUrl: PLUGIN_DIAGNOSTICS_DOCS,
      message: `Plugin ${entry.pluginId} is ${entry.installedVersion}, but a Gateway restart will load OpenClaw ${drift.gatewayVersion}.${targetResolution?.status === "resolved" ? ` The confirmed plugin target is ${targetResolution.version}.` : ""}${runningGatewayVersion ? ` The running Gateway is ${runningGatewayVersion}.` : ""}${updateCommand ? "" : ` Repair target resolution failed: ${targetError}.`}`,
      path: `plugins.entries.${entry.pluginId}`,
      target: entry.pluginId,
      requirement: "plugin-version-drift",
      fixHint: updateCommand
        ? `${formatCliCommand(updateCommand)} && ${formatCliCommand("openclaw gateway restart")}`
        : `No install command generated; retry openclaw doctor after checking registry availability (${targetError}).`,
    };
  });
}

function pluginDiagnosticToHealthFinding(
  diagnostic: WorkspacePluginDiagnostic,
  message: string,
): HealthFinding {
  return {
    checkId: WORKSPACE_STATUS_CHECK_ID,
    severity: diagnostic.level === "warn" ? "warning" : diagnostic.level,
    category:
      diagnostic.level === "error" ||
      diagnostic.code === "configured-plugin-path-unavailable" ||
      diagnostic.code === "configured-plugin-path-inspection-failed" ||
      diagnostic.code === "sdk-incompatible"
        ? "fix-now"
        : "recommended",
    docsUrl: PLUGIN_DIAGNOSTICS_DOCS,
    fixHint:
      diagnostic.fixHint ??
      (diagnostic.level === "error"
        ? `Run openclaw plugins inspect ${diagnostic.pluginId ?? "--all"} --runtime to inspect the failure. Restore the configured plugin path or update the plugin, then rerun openclaw doctor.`
        : "Run openclaw plugins inspect --all to review the named configuration or compatibility notice; update the affected plugin when a compatible release is available."),
    message,
    ...(diagnostic.pluginId
      ? { path: `plugins.entries.${diagnostic.pluginId}`, target: diagnostic.pluginId }
      : {}),
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.errorCode ? { errorCode: diagnostic.errorCode } : {}),
    requirement: diagnostic.code || "plugin-diagnostic",
  };
}

/** Runtime failures belong to this Doctor run, independently of metadata-only inventory. */
export function collectPluginLoadHealthFindings(
  diagnostics: readonly WorkspacePluginDiagnostic[],
): HealthFinding[] {
  const seen = new Set<string>();
  return diagnostics
    .filter((diagnostic) => claimPluginDiagnostic(seen, diagnostic))
    .map((diagnostic) =>
      pluginDiagnosticToHealthFinding(
        diagnostic,
        `Plugin ${diagnostic.pluginId}: ${diagnostic.message}${diagnostic.errorCode ? ` [${diagnostic.errorCode}]` : ""} (${diagnostic.source})`,
      ),
    );
}

export function collectWorkspaceStatusHealthFindings(
  cfg: OpenClawConfig,
  options: {
    pluginVersionReadiness?: PluginVersionRestartReadiness;
    runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  } = {},
): HealthFinding[] {
  const workspaceFindings: HealthFinding[] = [];
  const agentIds = listAgentIds(cfg);
  const scopes = agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
  }));
  const reportedPluginDiagnostics = new Set<string>();
  for (const { agentId, workspaceDir } of scopes) {
    const inspect = () => {
      const registry = buildPluginRegistrySnapshotReport({ config: cfg, workspaceDir });
      const compatibilityWarnings = buildPluginCompatibilityWarnings({
        config: cfg,
        workspaceDir,
        report: registry,
      });
      const agentLabel = agentIds.length > 1 ? `Agent "${agentId}":` : "";
      const diagnostics = [
        ...registry.diagnostics,
        ...registry.plugins
          .filter(
            (plugin) =>
              plugin.status === "error" &&
              !registry.diagnostics.some(
                (diagnostic) => diagnostic.pluginId === plugin.id && diagnostic.level === "error",
              ),
          )
          .map((plugin): WorkspacePluginDiagnostic => ({
            level: "error",
            pluginId: plugin.id,
            source: plugin.source,
            message: plugin.error ?? `Plugin ${plugin.id} metadata inspection failed.`,
          })),
      ].filter((diagnostic) => claimPluginDiagnostic(reportedPluginDiagnostics, diagnostic));
      const prefix = agentLabel ? `${agentLabel} ` : "";
      workspaceFindings.push(
        ...compatibilityWarnings.map((message): HealthFinding => ({
          checkId: WORKSPACE_STATUS_CHECK_ID,
          severity: "warning",
          docsUrl: PLUGIN_DIAGNOSTICS_DOCS,
          message: `${prefix}${message}`,
          path: "plugins",
          category: "recommended",
          requirement: "plugin-compatibility",
          fixHint:
            "Update or replace the plugin so it no longer depends on legacy compatibility paths.",
        })),
        ...diagnostics.map((diagnostic) =>
          pluginDiagnosticToHealthFinding(diagnostic, `${prefix}${diagnostic.message}`),
        ),
      );
    };
    if (options.runWithPluginMetadataSnapshot) {
      options.runWithPluginMetadataSnapshot({ config: cfg, workspaceDir }, inspect);
    } else {
      inspect();
    }
  }

  return [
    ...pluginVersionReadinessToHealthFindings(options.pluginVersionReadiness),
    ...workspaceFindings,
  ];
}
