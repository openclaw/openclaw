import type { AnyAgentTool } from "../pi-tools.types.js";
import { jsonResult } from "./common.js";
import type { ActiviConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agent-scope.js";
import { installSkill } from "../skills-install.js";
import { loadWorkspaceSkillEntries } from "../skills.js";
import { buildWorkspaceSkillStatus } from "../skills-status.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export type SkillsToolOptions = {
  agentSessionKey?: string;
  config?: ActiviConfig;
};

export function createSkillsTool(options?: SkillsToolOptions): AnyAgentTool {
  return {
    label: "Skills",
    name: "skills_manage",
    description: `Manage skills dynamically: install, uninstall, enable, disable, and list available skills.
Use this tool when you need a skill that isn't currently available, or when you want to remove a skill you no longer need.
The agent can install skills from the workspace, managed, or bundled skill directories.
After installing or uninstalling, the skills will be available/unavailable in subsequent agent runs.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "install", "uninstall", "enable", "disable", "status"],
          description: "Action to perform: list available skills, install a skill, uninstall a skill, enable/disable a skill, or check status",
        },
        skillName: {
          type: "string",
          description: "Name of the skill (required for install/uninstall/enable/disable)",
        },
        installId: {
          type: "string",
          description: "Install method ID (e.g., 'brew', 'npm', 'download') - required for install action",
        },
        agentId: {
          type: "string",
          description: "Optional agent ID (defaults to current agent)",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: string, params: unknown, _signal?: AbortSignal) => {
      const args = params as {
        action: "list" | "install" | "uninstall" | "enable" | "disable" | "status";
        skillName?: string;
        installId?: string;
        agentId?: string;
      };
      const cfg = options?.config ?? loadConfig();
      const agentIdRaw = args.agentId?.trim() || "";
      const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

      switch (args.action) {
        case "list": {
          const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
          const skills = entries.map((entry) => ({
            name: entry.skill.name,
            description: entry.skill.description || "",
            source: entry.skill.filePath.includes("bundled") ? "bundled" : 
                    entry.skill.filePath.includes(".activi") ? "managed" : "workspace",
            available: true,
            metadata: entry.metadata,
          }));
          return jsonResult({
            ok: true,
            skills,
            count: skills.length,
            message: `Found ${skills.length} available skills`,
          });
        }

        case "status": {
          const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
          const skill = args.skillName
            ? report.skills.find((s) => s.name === args.skillName || s.skillKey === args.skillName)
            : null;
          
          if (args.skillName && !skill) {
            return jsonResult({
              ok: false,
              message: `Skill not found: ${args.skillName}`,
            });
          }

          return jsonResult({
            ok: true,
            skill: skill || null,
            allSkills: report.skills,
            message: skill
              ? `Status for skill: ${skill.name}`
              : `Status for all skills (${report.skills.length} total)`,
          });
        }

        case "install": {
          if (!args.skillName) {
            return jsonResult({
              ok: false,
              message: "skillName is required for install action",
            });
          }
          if (!args.installId) {
            return jsonResult({
              ok: false,
              message: "installId is required for install action (e.g., 'brew', 'npm', 'download')",
            });
          }

          try {
            const result = await installSkill({
              workspaceDir,
              skillName: args.skillName,
              installId: args.installId,
              timeoutMs: 120_000,
              config: cfg,
            });

            if (result.ok) {
              return jsonResult({
                ok: true,
                message: `Successfully installed skill: ${args.skillName}`,
                stdout: result.stdout || "",
                stderr: result.stderr || "",
              });
            } else {
              return jsonResult({
                ok: false,
                message: `Failed to install skill: ${result.message}`,
                stdout: result.stdout || "",
                stderr: result.stderr || "",
                code: result.code || null,
              });
            }
          } catch (error) {
            return jsonResult({
              ok: false,
              message: `Error installing skill: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }

        case "uninstall": {
          if (!args.skillName) {
            return jsonResult({
              ok: false,
              message: "skillName is required for uninstall action",
            });
          }

          // Uninstall = disable skill in config
          const skills = cfg.skills ? { ...cfg.skills } : {};
          const entries = skills.entries ? { ...skills.entries } : {};
          
          // Find skill key
          const entries_list = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
          const entry = entries_list.find((e) => e.skill.name === args.skillName);
          const skillKey = entry?.metadata?.skillKey || args.skillName;

          if (entries[skillKey]) {
            entries[skillKey] = {
              ...entries[skillKey],
              enabled: false,
            };
          } else {
            entries[skillKey] = {
              enabled: false,
            };
          }

          skills.entries = entries;
          const nextConfig: ActiviConfig = {
            ...cfg,
            skills,
          };
          await writeConfigFile(nextConfig);

          return jsonResult({
            ok: true,
            message: `Disabled skill: ${args.skillName} (skillKey: ${skillKey})`,
            note: "Skill files remain in workspace. To fully remove, delete the skill directory manually.",
          });
        }

        case "enable": {
          if (!args.skillName) {
            return jsonResult({
              ok: false,
              message: "skillName is required for enable action",
            });
          }

          const skills = cfg.skills ? { ...cfg.skills } : {};
          const entries = skills.entries ? { ...skills.entries } : {};
          
          const entries_list = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
          const entry = entries_list.find((e) => e.skill.name === args.skillName);
          const skillKey = entry?.metadata?.skillKey || args.skillName;

          entries[skillKey] = {
            ...(entries[skillKey] || {}),
            enabled: true,
          };

          skills.entries = entries;
          const nextConfig: ActiviConfig = {
            ...cfg,
            skills,
          };
          await writeConfigFile(nextConfig);

          return jsonResult({
            ok: true,
            message: `Enabled skill: ${args.skillName} (skillKey: ${skillKey})`,
          });
        }

        case "disable": {
          if (!args.skillName) {
            return jsonResult({
              ok: false,
              message: "skillName is required for disable action",
            });
          }

          const skills = cfg.skills ? { ...cfg.skills } : {};
          const entries = skills.entries ? { ...skills.entries } : {};
          
          const entries_list = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
          const entry = entries_list.find((e) => e.skill.name === args.skillName);
          const skillKey = entry?.metadata?.skillKey || args.skillName;

          entries[skillKey] = {
            ...(entries[skillKey] || {}),
            enabled: false,
          };

          skills.entries = entries;
          const nextConfig: ActiviConfig = {
            ...cfg,
            skills,
          };
          await writeConfigFile(nextConfig);

          return jsonResult({
            ok: true,
            message: `Disabled skill: ${args.skillName} (skillKey: ${skillKey})`,
          });
        }

        default:
          return jsonResult({
            ok: false,
            message: `Unknown action: ${args.action}`,
          });
      }
    },
  };
}
