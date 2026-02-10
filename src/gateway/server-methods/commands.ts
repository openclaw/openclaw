import type { CommandCategory } from "../../auto-reply/commands-registry.types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  listChatCommandsForConfig,
  resolveCommandArgChoices,
  type ChatCommandDefinition,
  type CommandArgDefinition,
  type CommandScope,
} from "../../auto-reply/commands-registry.js";
import { listSkillCommandsForAgents } from "../../auto-reply/skill-commands.js";
import { loadConfig } from "../../config/config.js";
import { listPluginCommands } from "../../plugins/commands.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCommandsListParams,
} from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";

type CommandsListSource = "core" | "skill" | "plugin";

type CommandsListArgChoice = {
  value: string;
  label: string;
};

type CommandsListArg = {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  captureRemaining?: boolean;
  choices?: CommandsListArgChoice[];
};

type CommandsListEntry = {
  key: string;
  name: string;
  slash: string;
  description: string;
  scope: CommandScope;
  source: CommandsListSource;
  category?: CommandCategory;
  aliases?: string[];
  nativeName?: string;
  acceptsArgs?: boolean;
  args?: CommandsListArg[];
};

function stripLeadingSlash(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

function resolvePrimaryCommandName(command: ChatCommandDefinition): string {
  const primaryAlias = command.textAliases.find((alias) => stripLeadingSlash(alias).length > 0);
  if (primaryAlias) {
    return stripLeadingSlash(primaryAlias);
  }
  const nativeName = command.nativeName?.trim();
  if (nativeName) {
    return nativeName;
  }
  return command.key;
}

function resolveCommandAliases(command: ChatCommandDefinition, primaryName: string): string[] {
  const dedupe = new Set<string>();
  const aliases: string[] = [];
  for (const alias of command.textAliases) {
    const normalized = stripLeadingSlash(alias);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (key === primaryName.toLowerCase() || dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    aliases.push(normalized);
  }
  return aliases;
}

function resolveCommandArgs(params: {
  command: ChatCommandDefinition;
  cfg: ReturnType<typeof loadConfig>;
  provider?: string;
}): CommandsListArg[] | undefined {
  const { command, cfg, provider } = params;
  if (!command.args?.length) {
    return undefined;
  }
  const args = command.args.map((arg) => mapCommandArg({ command, arg, cfg, provider }));
  return args.length > 0 ? args : undefined;
}

function mapCommandArg(params: {
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
  cfg: ReturnType<typeof loadConfig>;
  provider?: string;
}): CommandsListArg {
  const { command, arg, cfg, provider } = params;
  const choices = resolveCommandArgChoices({ command, arg, cfg, provider });
  return {
    name: arg.name,
    description: arg.description,
    type: arg.type,
    ...(typeof arg.required === "boolean" ? { required: arg.required } : {}),
    ...(arg.captureRemaining ? { captureRemaining: true } : {}),
    ...(choices.length > 0 ? { choices } : {}),
  };
}

function resolveSkillCommandsForRequest(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey?: string;
}) {
  const { cfg, sessionKey } = params;
  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey) {
    return listSkillCommandsForAgents({ cfg });
  }
  const canonicalKey = (() => {
    try {
      return loadSessionEntry(normalizedSessionKey).canonicalKey;
    } catch {
      return normalizedSessionKey;
    }
  })();
  const agentId = resolveSessionAgentId({ sessionKey: canonicalKey, config: cfg });
  return listSkillCommandsForAgents({ cfg, agentIds: [agentId] });
}

function mapChatCommandToEntry(params: {
  command: ChatCommandDefinition;
  cfg: ReturnType<typeof loadConfig>;
  provider?: string;
}): CommandsListEntry {
  const { command, cfg, provider } = params;
  const primaryName = resolvePrimaryCommandName(command);
  const aliases = resolveCommandAliases(command, primaryName);
  const source: CommandsListSource = command.key.startsWith("skill:") ? "skill" : "core";
  const args = resolveCommandArgs({ command, cfg, provider });
  return {
    key: command.key,
    name: primaryName,
    slash: `/${primaryName}`,
    description: command.description,
    scope: command.scope,
    source,
    ...(command.category ? { category: command.category } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(command.nativeName ? { nativeName: command.nativeName } : {}),
    ...(typeof command.acceptsArgs === "boolean" ? { acceptsArgs: command.acceptsArgs } : {}),
    ...(args ? { args } : {}),
  };
}

export const commandsHandlers: GatewayRequestHandlers = {
  "commands.list": ({ params, respond }) => {
    if (!validateCommandsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid commands.list params: ${formatValidationErrors(validateCommandsListParams.errors)}`,
        ),
      );
      return;
    }

    const p = (params ?? {}) as {
      provider?: string;
      sessionKey?: string;
      includePlugins?: boolean;
      includeSkills?: boolean;
    };
    const cfg = loadConfig();
    const provider = p.provider?.trim().toLowerCase();
    const includeSkills = p.includeSkills !== false;
    const includePlugins = p.includePlugins !== false;
    const skillCommands = includeSkills
      ? resolveSkillCommandsForRequest({
          cfg,
          sessionKey: p.sessionKey,
        })
      : undefined;

    const commands = listChatCommandsForConfig(cfg, { skillCommands }).map((command) =>
      mapChatCommandToEntry({ command, cfg, provider }),
    );

    if (includePlugins) {
      for (const pluginCommand of listPluginCommands()) {
        const name = stripLeadingSlash(pluginCommand.name);
        if (!name) {
          continue;
        }
        commands.push({
          key: `plugin:${name}`,
          name,
          slash: `/${name}`,
          description: pluginCommand.description,
          scope: "text",
          source: "plugin",
        });
      }
    }

    respond(true, { commands }, undefined);
  },
};
