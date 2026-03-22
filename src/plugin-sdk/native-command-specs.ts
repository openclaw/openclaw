import type { SkillCommandSpec } from "../agents/skills.js";
import type {
  ChatCommandDefinition,
  NativeCommandSpec,
} from "../auto-reply/commands-registry.types.js";
import type { OpenClawConfig } from "../config/config.js";
import { getChatCommands } from "../auto-reply/commands-registry.data.js";
import { isCommandFlagEnabled } from "../config/commands.js";

function buildSkillCommandDefinitions(skillCommands?: SkillCommandSpec[]): ChatCommandDefinition[] {
  if (!skillCommands || skillCommands.length === 0) {
    return [];
  }
  return skillCommands.map((spec) => ({
    key: `skill:${spec.skillName}`,
    nativeName: spec.name,
    description: spec.description,
    textAliases: [`/${spec.name}`],
    acceptsArgs: true,
    argsParsing: "none",
    scope: "both",
  }));
}

function listChatCommands(params?: {
  skillCommands?: SkillCommandSpec[];
}): ChatCommandDefinition[] {
  const commands = getChatCommands();
  if (!params?.skillCommands?.length) {
    return [...commands];
  }
  return [...commands, ...buildSkillCommandDefinitions(params.skillCommands)];
}

function isCommandEnabled(cfg: OpenClawConfig, commandKey: string): boolean {
  if (commandKey === "config") {
    return isCommandFlagEnabled(cfg, "config");
  }
  if (commandKey === "mcp") {
    return isCommandFlagEnabled(cfg, "mcp");
  }
  if (commandKey === "plugins") {
    return isCommandFlagEnabled(cfg, "plugins");
  }
  if (commandKey === "debug") {
    return isCommandFlagEnabled(cfg, "debug");
  }
  if (commandKey === "bash") {
    return isCommandFlagEnabled(cfg, "bash");
  }
  return true;
}

function listChatCommandsForConfig(
  cfg: OpenClawConfig,
  params?: { skillCommands?: SkillCommandSpec[] },
): ChatCommandDefinition[] {
  const base = getChatCommands().filter((command) => isCommandEnabled(cfg, command.key));
  if (!params?.skillCommands?.length) {
    return base;
  }
  return [...base, ...buildSkillCommandDefinitions(params.skillCommands)];
}

const NATIVE_NAME_OVERRIDES: Record<string, Record<string, string>> = {
  discord: {
    tts: "voice",
  },
  slack: {
    status: "agentstatus",
  },
};

function resolveNativeName(command: ChatCommandDefinition, provider?: string): string | undefined {
  if (!command.nativeName) {
    return undefined;
  }
  if (provider) {
    const override = NATIVE_NAME_OVERRIDES[provider]?.[command.key];
    if (override) {
      return override;
    }
  }
  return command.nativeName;
}

function toNativeCommandSpec(command: ChatCommandDefinition, provider?: string): NativeCommandSpec {
  return {
    name: resolveNativeName(command, provider) ?? command.key,
    description: command.description,
    acceptsArgs: Boolean(command.acceptsArgs),
    args: command.args,
  };
}

function listNativeSpecsFromCommands(
  commands: ChatCommandDefinition[],
  provider?: string,
): NativeCommandSpec[] {
  return commands
    .filter((command) => command.scope !== "text" && command.nativeName)
    .map((command) => toNativeCommandSpec(command, provider));
}

export function listNativeCommandSpecs(params?: {
  skillCommands?: SkillCommandSpec[];
  provider?: string;
}): NativeCommandSpec[] {
  return listNativeSpecsFromCommands(
    listChatCommands({ skillCommands: params?.skillCommands }),
    params?.provider,
  );
}

export function listNativeCommandSpecsForConfig(
  cfg: OpenClawConfig,
  params?: { skillCommands?: SkillCommandSpec[]; provider?: string },
): NativeCommandSpec[] {
  return listNativeSpecsFromCommands(listChatCommandsForConfig(cfg, params), params?.provider);
}
