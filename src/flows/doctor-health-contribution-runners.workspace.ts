import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { shouldManageGatewayService } from "../commands/doctor-service-repair-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { resolveDoctorWorkspaceSuggestionScopes } from "./doctor-workspace-suggestion-scopes.js";

type PluginVersionRestartReadiness =
  import("../plugins/plugin-version-drift.js").PluginVersionRestartReadiness;

export async function runHooksModelHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { collectHooksModelIssues } = await import("../commands/doctor-hooks-model.js");
  const issues = await collectHooksModelIssues(ctx.cfg);
  if (issues.length === 0) {
    return;
  }
  const { note } = await import("../../packages/terminal-core/src/note.js");
  const warnings = issues.map(({ kind, model }) =>
    kind === "unresolved"
      ? `- hooks.gmail.model "${model}" could not be resolved`
      : kind === "not-allowed"
        ? `- hooks.gmail.model "${model}" not allowed by agents.defaults.modelPolicy.allow (will use primary instead)`
        : `- hooks.gmail.model "${model}" not in the model catalog (may fail at runtime)`,
  );
  note(warnings.join("\n"), "Hooks");
}

export async function collectWorkspaceStatusPluginVersionReadiness(params: {
  cfg: OpenClawConfig;
  options?: Pick<DoctorOptions, "allowExec" | "deep" | "nonInteractive">;
}): Promise<PluginVersionRestartReadiness | undefined> {
  if (params.cfg.gateway?.mode === "remote" || !(await shouldManageGatewayService())) {
    return undefined;
  }
  try {
    const { gatherDaemonStatus } = await import("../cli/daemon-cli/status.gather.js");
    const status = await gatherDaemonStatus({
      rpc: { timeout: params.options?.nonInteractive === true ? "3000" : "10000", json: true },
      probe: true,
      requireRpc: false,
      deep: params.options?.deep === true,
      allowExecSecretRefs: params.options?.allowExec === true,
      pluginVersionTarget: "restart",
    });
    if (status.pluginVersionRestartReadiness?.status === "resolved") {
      const { resolvePluginVersionDriftTargets } =
        await import("../plugins/plugin-version-drift.js");
      return {
        ...status.pluginVersionRestartReadiness,
        report: await resolvePluginVersionDriftTargets(status.pluginVersionRestartReadiness.report),
      };
    }
    return status.pluginVersionRestartReadiness;
  } catch {
    // The core Gateway health check owns general collection failures. Without status we
    // cannot establish that a managed service and version-bound plugin make this check apply.
    return undefined;
  }
}

export async function runWorkspaceStatusHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const pluginVersionReadiness = await collectWorkspaceStatusPluginVersionReadiness({
    cfg: ctx.cfg,
    options: ctx.options,
  });
  const { noteWorkspaceStatus } = await import("../commands/doctor-workspace-status.js");
  noteWorkspaceStatus(ctx.cfg, {
    pluginVersionReadiness,
    ...(ctx.runWithPluginMetadataSnapshot
      ? { runWithPluginMetadataSnapshot: ctx.runWithPluginMetadataSnapshot }
      : {}),
  });
}

export async function runWorkspaceAliasHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { collectRepointedWorkspaceAliasFindings } =
    await import("../commands/doctor-workspace-alias.js");
  const findings = await collectRepointedWorkspaceAliasFindings(ctx.cfg);
  if (findings.length > 0) {
    const { note } = await import("../../packages/terminal-core/src/note.js");
    note(
      findings.map((finding) => `${finding.message} ${finding.fixHint}`).join("\n"),
      "Workspace",
    );
  }
}

export async function runSkillsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairSkillReadiness } = await import("../commands/doctor-skills.js");
  ctx.cfg = await maybeRepairSkillReadiness({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
    ...(ctx.runWithPluginMetadataSnapshot
      ? { runWithPluginMetadataSnapshot: ctx.runWithPluginMetadataSnapshot }
      : {}),
  });
}

export async function runBootstrapSizeHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteBootstrapFileSize } = await import("../commands/doctor-bootstrap-size.js");
  await noteBootstrapFileSize(ctx.cfg);
}

export async function runHeartbeatCadenceMigrationHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { maybeMigrateHeartbeatCadenceToCron } =
    await import("../commands/doctor-heartbeat-cadence-migration.js");
  await maybeMigrateHeartbeatCadenceToCron({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
    env: ctx.env,
  });
}

export async function runHeartbeatScratchMigrationHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { maybeMigrateHeartbeatFilesToScratch } =
    await import("../commands/doctor-heartbeat-scratch-migration.js");
  await maybeMigrateHeartbeatFilesToScratch({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
    env: ctx.env,
  });
}

export async function runToolsMdMigrationHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeMigrateToolsMd } = await import("../commands/doctor-tools-md-migration.js");
  await maybeMigrateToolsMd({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
    env: ctx.env,
  });
}

export async function runHeartbeatTaskMigrationHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeMigrateHeartbeatTasksToCron } =
    await import("../commands/doctor-heartbeat-task-migration.js");
  await maybeMigrateHeartbeatTasksToCron({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
    env: ctx.env,
  });
}

export async function runMemorySearchHealthContribution(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth } =
    await import("../commands/doctor-memory-recall.js");
  const { noteMemorySearchHealth } = await import("../commands/doctor-memory-search.js");
  if (ctx.prompter.shouldRepair) {
    await maybeRepairMemoryRecallHealth({ cfg: ctx.cfg, prompter: ctx.prompter });
  }
  await noteMemorySearchHealth(ctx.cfg, {
    env: ctx.env,
    gatewayMemoryProbe: ctx.gatewayMemoryProbe ?? { checked: false, ready: false, skipped: false },
  });
  if (ctx.options.deep === true) {
    await noteMemoryRecallHealth(ctx.cfg);
  }
}

export async function runWorkspaceSuggestionsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (ctx.options.workspaceSuggestions === false) {
    return;
  }
  const { collectWorkspaceSuggestionNotes } =
    await import("../commands/doctor-workspace-suggestions.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  for (const { agentId, workspaceDir, labelAgent } of resolveDoctorWorkspaceSuggestionScopes(
    ctx.cfg,
  )) {
    const prefix = labelAgent ? `Agent "${agentId}": ` : "";
    for await (const suggestion of collectWorkspaceSuggestionNotes(workspaceDir)) {
      note(`${prefix}${suggestion}`, "Workspace");
    }
  }
}
