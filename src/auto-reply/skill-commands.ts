import fs from "node:fs";

import type { ClawdbotConfig } from "../config/config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { buildWorkspaceSkillCommandSpecs, type SkillCommandSpec } from "../agents/skills.js";
import { listChatCommands } from "./commands-registry.js";

function resolveReservedCommandNames(): Set<string> {
  const reserved = new Set<string>();
  for (const command of listChatCommands()) {
    if (command.nativeName) reserved.add(command.nativeName.toLowerCase());
    for (const alias of command.textAliases) {
      const trimmed = alias.trim();
      if (!trimmed.startsWith("/")) continue;
      reserved.add(trimmed.slice(1).toLowerCase());
    }
  }
  return reserved;
}

export function listSkillCommandsForWorkspace(params: {
  workspaceDir: string;
  cfg: ClawdbotConfig;
  skillFilter?: string[];
}): SkillCommandSpec[] {
  return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
    config: params.cfg,
    skillFilter: params.skillFilter,
    eligibility: { remote: getRemoteSkillEligibility() },
    reservedNames: resolveReservedCommandNames(),
  });
}

export function listSkillCommandsForAgents(params: {
  cfg: ClawdbotConfig;
  agentIds?: string[];
}): SkillCommandSpec[] {
  const used = resolveReservedCommandNames();
  const entries: SkillCommandSpec[] = [];
  const agentIds = params.agentIds ?? listAgentIds(params.cfg);
  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    if (!fs.existsSync(workspaceDir)) continue;
    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      config: params.cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
      reservedNames: used,
    });
    for (const command of commands) {
      used.add(command.name.toLowerCase());
      entries.push(command);
    }
  }
  return entries;
}

export function resolveSkillCommandInvocation(params: {
  commandBodyNormalized: string;
  skillCommands: SkillCommandSpec[];
}): { command: SkillCommandSpec; args?: string } | null {
  const trimmed = params.commandBodyNormalized.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) return null;
  const commandName = match[1]?.trim().toLowerCase();
  if (!commandName) return null;
  const command = params.skillCommands.find((entry) => entry.name.toLowerCase() === commandName);
  if (!command) return null;
  const args = match[2]?.trim();
  return { command, args: args || undefined };
}
