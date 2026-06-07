/** Doctor status summary for workspace skills, plugins, and task-flow recovery hints. */
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-record-reader.js";
import { detectPluginVersionDrift } from "../plugins/plugin-version-drift.js";
import {
  buildPluginCompatibilityWarnings,
  buildPluginRegistrySnapshotReport,
} from "../plugins/status.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import { listTasksForFlowId } from "../tasks/runtime-internal.js";
import { listTaskFlowRecords } from "../tasks/task-flow-runtime-internal.js";
import { VERSION } from "../version.js";
import { detectLegacyWorkspaceDirs, formatLegacyWorkspaceWarning } from "./doctor-workspace.js";

function noteFlowRecoveryHints() {
  const suspicious = listTaskFlowRecords().flatMap((flow) => {
    const tasks = listTasksForFlowId(flow.flowId);
    const findings: string[] = [];
    if (
      flow.syncMode === "managed" &&
      flow.status === "running" &&
      tasks.length === 0 &&
      flow.waitJson === undefined
    ) {
      findings.push(
        `${flow.flowId}: running managed TaskFlow has no linked tasks or wait state; inspect or cancel it manually.`,
      );
    }
    if (
      flow.status === "blocked" &&
      flow.blockedTaskId &&
      !tasks.some((task) => task.taskId === flow.blockedTaskId)
    ) {
      findings.push(
        `${flow.flowId}: blocked TaskFlow points at missing task ${flow.blockedTaskId}; inspect before retrying.`,
      );
    }
    return findings;
  });
  if (suspicious.length === 0) {
    return;
  }
  note(
    [
      ...suspicious.slice(0, 5),
      suspicious.length > 5 ? `...and ${suspicious.length - 5} more.` : null,
      `Inspect: ${formatCliCommand("openclaw tasks flow show <flow-id>")}`,
      `Cancel: ${formatCliCommand("openclaw tasks flow cancel <flow-id>")}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    "TaskFlow recovery",
  );
}

type NoteWorkspaceStatusOptions = {
  /** Env for resolving plugin install record paths (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Running gateway version from a health probe, if available. Falls back to VERSION. */
  gatewayVersion?: string;
};

/** Emits workspace, skills, plugin, and TaskFlow recovery status notes for doctor. */
export async function noteWorkspaceStatus(cfg: OpenClawConfig, opts?: NoteWorkspaceStatusOptions) {
  const env = opts?.env ?? (process.env as Record<string, string | undefined>);
  const driftGatewayVersion = opts?.gatewayVersion ?? VERSION;
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const legacyWorkspace = detectLegacyWorkspaceDirs({ workspaceDir });
  if (legacyWorkspace.legacyDirs.length > 0) {
    note(formatLegacyWorkspaceWarning(legacyWorkspace), "Extra workspace");
  }

  const skillsReport = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  note(
    [
      `Eligible: ${skillsReport.skills.filter((s) => s.eligible).length}`,
      `Missing requirements: ${
        skillsReport.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist)
          .length
      }`,
      `Blocked by allowlist: ${skillsReport.skills.filter((s) => s.blockedByAllowlist).length}`,
    ].join("\n"),
    "Skills status",
  );

  const pluginRegistry = buildPluginRegistrySnapshotReport({
    config: cfg,
    workspaceDir,
  });
  if (pluginRegistry.plugins.length > 0) {
    const loaded = pluginRegistry.plugins.filter((p) => p.status === "loaded");
    const disabled = pluginRegistry.plugins.filter((p) => p.status === "disabled");
    const errored = pluginRegistry.plugins.filter((p) => p.status === "error");
    const imported = pluginRegistry.plugins.filter((p) => p.imported);

    const lines = [
      `Loaded: ${loaded.length}`,
      `Imported: ${imported.length}`,
      `Disabled: ${disabled.length}`,
      `Errors: ${errored.length}`,
      errored.length > 0
        ? `- ${errored
            .slice(0, 10)
            .map((p) => p.id)
            .join("\n- ")}${errored.length > 10 ? "\n- ..." : ""}`
        : null,
    ].filter((line): line is string => Boolean(line));

    const bundlePlugins = loaded.filter(
      (p) => p.format === "bundle" && (p.bundleCapabilities?.length ?? 0) > 0,
    );
    if (bundlePlugins.length > 0) {
      const allCaps = new Set(bundlePlugins.flatMap((p) => p.bundleCapabilities ?? []));
      lines.push(`Bundle plugins: ${bundlePlugins.length} (${[...allCaps].toSorted().join(", ")})`);
    }

    note(lines.join("\n"), "Plugins");
  }
  const compatibilityWarnings = buildPluginCompatibilityWarnings({
    config: cfg,
    workspaceDir,
    report: pluginRegistry,
  });
  if (compatibilityWarnings.length > 0) {
    note(compatibilityWarnings.map((line) => `- ${line}`).join("\n"), "Plugin compatibility");
  }
  // Check official managed plugin version drift against the running gateway.
  // Best-effort: don't let a plugin-index read failure block the rest of doctor.
  // Uses the same env/version inputs as gateway status --deep: env for resolving
  // managed install paths, and probed gateway version falling back to CLI VERSION.
  try {
    const installRecords = await loadInstalledPluginIndexInstallRecords({
      env: env as NodeJS.ProcessEnv,
    });
    const driftReport = detectPluginVersionDrift({
      gatewayVersion: driftGatewayVersion,
      installRecords,
      config: cfg,
    });
    if (driftReport.drifts.length > 0) {
      const driftLines = driftReport.drifts.map(
        (d) => `- ${d.pluginId}: ${d.installedVersion} -> expected ${d.gatewayVersion}`,
      );
      driftLines.push(
        `Fix: ${formatCliCommand("openclaw plugins update <plugin-id>")} for each drifted plugin, then ${formatCliCommand("openclaw gateway restart")}.`,
      );
      note(
        driftLines.join("\n"),
        `Plugin version drift: ${driftReport.drifts.length} active official plugin${driftReport.drifts.length !== 1 ? "s" : ""} not on gateway ${driftReport.gatewayVersion}`,
      );
    }
  } catch {
    // Plugin install-record loading can fail for transient filesystem or
    // permission reasons; doctor diagnostic is advisory only.
  }

  if (pluginRegistry.diagnostics.length > 0) {
    const lines = pluginRegistry.diagnostics.map((diag) => {
      const prefix = diag.level.toUpperCase();
      const plugin = diag.pluginId ? ` ${diag.pluginId}` : "";
      const source = diag.source ? ` (${diag.source})` : "";
      return `- ${prefix}${plugin}: ${diag.message}${source}`;
    });
    note(lines.join("\n"), "Plugin diagnostics");
  }

  noteFlowRecoveryHints();

  return { workspaceDir };
}
