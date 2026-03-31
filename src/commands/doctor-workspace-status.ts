import { listFlowRecords } from "openclaw/plugin-sdk/tasks";
import { listTasksForFlowId } from "openclaw/plugin-sdk/tasks";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildPluginCompatibilityWarnings, buildPluginStatusReport } from "../plugins/status.js";
import { note } from "../terminal/note.js";
import { detectLegacyWorkspaceDirs, formatLegacyWorkspaceWarning } from "./doctor-workspace.js";

function noteFlowRecoveryHints() {
  const suspicious = listFlowRecords().flatMap((flow) => {
    const tasks = listTasksForFlowId(flow.flowId);
    const findings: string[] = [];
    const missingWaitingTask =
      flow.shape === "linear" &&
      flow.status === "waiting" &&
      flow.waitingOnTaskId &&
      !tasks.some((task) => task.taskId === flow.waitingOnTaskId);
    const missingBlockedTask =
      flow.status === "blocked" &&
      flow.blockedTaskId &&
      !tasks.some((task) => task.taskId === flow.blockedTaskId);
    if (
      flow.shape === "linear" &&
      (flow.status === "running" || flow.status === "waiting" || flow.status === "blocked") &&
      tasks.length === 0 &&
      !missingWaitingTask &&
      !missingBlockedTask
    ) {
      findings.push(
        `${flow.flowId}: ${flow.status} linear flow has no linked tasks; inspect or cancel it manually.`,
      );
    }
    if (missingWaitingTask) {
      findings.push(
        `${flow.flowId}: waiting flow points at missing task ${flow.waitingOnTaskId}; inspect or cancel it manually.`,
      );
    }
    if (missingBlockedTask) {
      findings.push(
        `${flow.flowId}: blocked flow points at missing task ${flow.blockedTaskId}; inspect before retrying.`,
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
      `Inspect: ${formatCliCommand("openclaw flows show <flow-id>")}`,
      `Cancel: ${formatCliCommand("openclaw flows cancel <flow-id>")}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    "ClawFlow recovery",
  );
}

export function noteWorkspaceStatus(cfg: OpenClawConfig) {
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

  const pluginRegistry = buildPluginStatusReport({
    config: cfg,
    workspaceDir,
  });
  if (pluginRegistry.plugins.length > 0) {
    const loaded = pluginRegistry.plugins.filter((p) => p.status === "loaded");
    const disabled = pluginRegistry.plugins.filter((p) => p.status === "disabled");
    const errored = pluginRegistry.plugins.filter((p) => p.status === "error");

    const lines = [
      `Loaded: ${loaded.length}`,
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
