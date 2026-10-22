import { existsSync } from "node:fs";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import {
  detectGhConfigDirMismatch,
  formatGhConfigDirMismatchHint,
  type GhConfigDiscoveryInput,
} from "../skills/lifecycle/gh-config-discovery.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { shouldAutoApproveDoctorFix } from "./doctor-repair-mode.js";
import {
  collectUnavailableAgentSkills,
  disableUnavailableSkillsInConfig,
} from "./doctor-skills-core.js";

function describeGhConfigDirHint(skills: SkillStatusEntry[]): string[] {
  const discoveryInput: GhConfigDiscoveryInput = {
    platform: process.platform,
    env: process.env as GhConfigDiscoveryInput["env"],
    fileExists: existsSync,
  };
  const githubSkill = skills.find((skill) => skill.name === "github");
  if (!githubSkill?.eligible || githubSkill.blockedByAgentFilter) {
    return [];
  }
  const result = detectGhConfigDirMismatch(discoveryInput);
  if (result.kind !== "mismatch") {
    return [];
  }
  return formatGhConfigDirMismatchHint(result);
}

/** Checks every agent's skill readiness without disabling skills for missing local binaries. */
export async function maybeRepairSkillReadiness(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
}): Promise<OpenClawConfig> {
  const agentIds = listAgentIds(params.cfg);
  const scopes = agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId),
  }));
  const reports = scopes.map(({ agentId, workspaceDir }) => {
    const buildReport = () => {
      const report = buildWorkspaceSkillStatus(workspaceDir, {
        config: params.cfg,
        agentId,
      });
      return { agentId, skills: report.skills, unavailable: collectUnavailableAgentSkills(report) };
    };
    return params.runWithPluginMetadataSnapshot
      ? params.runWithPluginMetadataSnapshot({ config: params.cfg, workspaceDir }, buildReport)
      : buildReport();
  });
  // A locally missing binary may be provided by a paired node for this agent.
  const preservedKeys = new Set(
    reports.flatMap(({ skills }) =>
      skills
        .filter(
          (skill) =>
            !skill.blockedByAgentFilter &&
            (skill.eligible || skill.missing.bins.length > 0 || skill.missing.anyBins.length > 0),
        )
        .map((skill) => skill.skillKey),
    ),
  );
  const candidates = new Map<string, SkillStatusEntry>();
  for (const skill of reports.flatMap(({ unavailable }) => unavailable)) {
    if (!preservedKeys.has(skill.skillKey)) {
      candidates.set(skill.skillKey, skill);
    }
  }
  const fleetUnavailable = [...candidates.values()];
  const globallyUnavailableKeys = new Set(fleetUnavailable.map((skill) => skill.skillKey));
  const willRepair = shouldAutoApproveDoctorFix(params.prompter.repairMode, {
    blockDuringUpdate: true,
  });
  for (const { agentId, skills, unavailable: unavailableForAgent } of reports) {
    const prefix = agentIds.length > 1 ? `Agent "${agentId}":\n` : "";
    const githubHint = describeGhConfigDirHint(skills);
    if (githubHint.length > 0) {
      note(`${prefix}${githubHint.join("\n")}`, "GitHub CLI");
    }
    if (unavailableForAgent.length > 0) {
      const includesGlobalCandidate = unavailableForAgent.some((skill) =>
        globallyUnavailableKeys.has(skill.skillKey),
      );
      const count = unavailableForAgent.length;
      const lines = [
        `${count} allowed skill${count === 1 ? " is" : "s are"} not usable in this environment (missing binaries, env vars, or config).`,
        `- ${unavailableForAgent
          .map((skill) => skill.name)
          .toSorted((a, b) => a.localeCompare(b))
          .join(", ")}`,
      ];
      if (
        unavailableForAgent.some(
          (skill) => skill.missing.bins.length > 0 || skill.missing.anyBins.length > 0,
        )
      ) {
        lines.push(
          "Missing local binaries may exist on paired nodes; these skills remain enabled.",
        );
      }
      if (includesGlobalCandidate && !willRepair) {
        lines.push(`Disable unused skills: ${formatCliCommand("openclaw doctor --fix")}`);
      }
      lines.push(
        `Inspect details: ${formatCliCommand("openclaw skills check --agent <id>")} or ${formatCliCommand("openclaw skills info <name> --agent <id>")}`,
      );
      note(`${prefix}${lines.join("\n")}`, "Skills");
    }
  }
  if (fleetUnavailable.length === 0) {
    return params.cfg;
  }

  // Updating may migrate required state, but must not disable optional skills for this environment.
  const shouldDisable = await params.prompter.confirmRuntimeRepair({
    message:
      agentIds.length === 1
        ? `Disable ${fleetUnavailable.length} unavailable skill${fleetUnavailable.length === 1 ? "" : "s"} in config?`
        : `Disable ${fleetUnavailable.length} skill${fleetUnavailable.length === 1 ? "" : "s"} unavailable to every configured agent?`,
    initialValue: false,
  });
  if (!shouldDisable) {
    return params.cfg;
  }

  const next = disableUnavailableSkillsInConfig(params.cfg, fleetUnavailable);
  note(fleetUnavailable.map((skill) => `- Disabled ${skill.name}`).join("\n"), "Doctor changes");
  return next;
}
