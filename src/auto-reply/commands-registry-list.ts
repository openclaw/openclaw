import { isCommandFlagEnabled } from "../config/commands.flags.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillCommandSpec } from "../skills/types.js";
import { getChatCommands } from "./commands-registry.data.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";

export function listChatCommands(params?: {
  skillCommands?: SkillCommandSpec[];
}): ChatCommandDefinition[] {
  return [
    ...getChatCommands(),
    ...(params?.skillCommands ?? []).map((spec): ChatCommandDefinition => ({
      key: `skill:${spec.skillName}`,
      nativeName: spec.name,
      description: spec.description,
      textAliases: [`/${spec.name}`],
      acceptsArgs: true,
      argsParsing: "none",
      scope: "both",
      category: "tools",
      ...(spec.descriptionLocalizations
        ? { descriptionLocalizations: spec.descriptionLocalizations }
        : {}),
    })),
  ];
}

/** Applies config feature flags to command keys that can be operator-disabled. */
export function isCommandEnabled(cfg: OpenClawConfig, commandKey: string): boolean {
  return commandKey === "config" ||
    commandKey === "mcp" ||
    commandKey === "plugins" ||
    commandKey === "debug" ||
    commandKey === "bash"
    ? isCommandFlagEnabled(cfg, commandKey)
    : true;
}

export function listChatCommandsForConfig(
  cfg: OpenClawConfig,
  params?: { skillCommands?: SkillCommandSpec[] },
): ChatCommandDefinition[] {
  return listChatCommands(params).filter((command) => isCommandEnabled(cfg, command.key));
}
