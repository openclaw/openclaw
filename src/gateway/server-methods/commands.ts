import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listChatCommandsForConfig } from "../../auto-reply/commands-registry.js";
import type {
  ChatCommandDefinition,
  CommandArgChoice,
  CommandArgDefinition,
} from "../../auto-reply/commands-registry.types.js";
import { listSkillCommandsForAgents } from "../../auto-reply/skill-commands.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { loadConfig } from "../../config/config.js";
import { getPluginCommandSpecs } from "../../plugins/command-registry-state.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import type { CommandEntry, CommandsListResult } from "../protocol/index.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCommandsListParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type SerializedArg = NonNullable<CommandEntry["args"]>[number];

function resolveAgentIdOrRespondError(rawAgentId: unknown, respond: RespondFn) {
  const cfg = loadConfig();
  const knownAgents = listAgentIds(cfg);
  const requestedAgentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const agentId = requestedAgentId || resolveDefaultAgentId(cfg);
  if (requestedAgentId && !knownAgents.includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg, agentId };
}

function resolveNativeName(cmd: ChatCommandDefinition, provider?: string): string {
  const baseName = cmd.nativeName ?? cmd.key;
  if (!provider || !cmd.nativeName) {
    return baseName;
  }
  return (
    getChannelPlugin(provider)?.commands?.resolveNativeCommandName?.({
      commandKey: cmd.key,
      defaultName: cmd.nativeName,
    }) ?? baseName
  );
}

function serializeArg(arg: CommandArgDefinition): SerializedArg {
  const isDynamic = typeof arg.choices === "function";
  const staticChoices = Array.isArray(arg.choices) ? arg.choices.map(normalizeChoice) : undefined;
  return {
    name: arg.name,
    description: arg.description,
    type: arg.type,
    ...(arg.required ? { required: true } : {}),
    ...(staticChoices ? { choices: staticChoices } : {}),
    ...(isDynamic ? { dynamic: true } : {}),
  };
}

function normalizeChoice(choice: CommandArgChoice): { value: string; label: string } {
  return typeof choice === "string" ? { value: choice, label: choice } : choice;
}

function mapCommand(
  cmd: ChatCommandDefinition,
  source: "native" | "skill",
  includeArgs: boolean,
  provider?: string,
): CommandEntry {
  const shouldIncludeArgs = includeArgs && cmd.acceptsArgs && cmd.args?.length;
  return {
    name: resolveNativeName(cmd, provider),
    description: cmd.description,
    ...(cmd.category ? { category: cmd.category } : {}),
    source,
    scope: cmd.scope,
    acceptsArgs: Boolean(cmd.acceptsArgs),
    ...(shouldIncludeArgs ? { args: cmd.args!.map(serializeArg) } : {}),
  };
}

export function buildCommandsListResult(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  provider?: string;
  scope?: "native" | "text" | "both";
  includeArgs?: boolean;
}): CommandsListResult {
  const includeArgs = params.includeArgs !== false;
  const scopeFilter = params.scope ?? "both";
  const provider = normalizeOptionalLowercaseString(params.provider);

  const skillCommands = listSkillCommandsForAgents({ cfg: params.cfg, agentIds: [params.agentId] });
  const chatCommands = listChatCommandsForConfig(params.cfg, { skillCommands });
  const skillKeys = new Set(skillCommands.map((sc) => `skill:${sc.skillName}`));

  const commands: CommandEntry[] = [];

  for (const cmd of chatCommands) {
    if (scopeFilter !== "both" && cmd.scope !== "both" && cmd.scope !== scopeFilter) {
      continue;
    }
    commands.push(
      mapCommand(cmd, skillKeys.has(cmd.key) ? "skill" : "native", includeArgs, provider),
    );
  }

  const pluginSpecs = getPluginCommandSpecs(provider);
  for (const spec of pluginSpecs) {
    commands.push({
      name: spec.name,
      description: spec.description,
      source: "plugin",
      scope: "both",
      acceptsArgs: spec.acceptsArgs,
    });
  }

  return { commands };
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
    const resolved = resolveAgentIdOrRespondError(params.agentId, respond);
    if (!resolved) {
      return;
    }
    respond(
      true,
      buildCommandsListResult({
        cfg: resolved.cfg,
        agentId: resolved.agentId,
        provider: params.provider,
        scope: params.scope,
        includeArgs: params.includeArgs,
      }),
      undefined,
    );
  },
};
