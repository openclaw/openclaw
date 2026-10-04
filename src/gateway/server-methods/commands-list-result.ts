import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  CommandEntry,
  CommandsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  COMMAND_ALIAS_MAX_ITEMS,
  COMMAND_ARG_CHOICES_MAX_ITEMS,
  COMMAND_ARG_DESCRIPTION_MAX_LENGTH,
  COMMAND_ARG_NAME_MAX_LENGTH,
  COMMAND_ARGS_MAX_ITEMS,
  COMMAND_CHOICE_LABEL_MAX_LENGTH,
  COMMAND_CHOICE_VALUE_MAX_LENGTH,
  COMMAND_DESCRIPTION_MAX_LENGTH,
  COMMAND_LIST_MAX_ITEMS,
  COMMAND_NAME_MAX_LENGTH,
} from "../../../packages/gateway-protocol/src/schema/commands.js";
import {
  listChatCommandsForConfig,
  supportsNativeProvider,
} from "../../auto-reply/commands-registry.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getPluginCommandEntrySpecs,
  getPluginCommandEntrySpecsFromRegistrations,
} from "../../plugins/command-specs.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import { prepareSkillCommandsForAgents } from "../../skills/discovery/chat-commands.js";

export async function buildCommandsListResult(params: {
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  scope?: "native" | "text" | "both";
  includeArgs?: boolean;
}): Promise<CommandsListResult> {
  const includeArgs = params.includeArgs !== false;
  const scopeFilter = params.scope ?? "both";
  const nameSurface = scopeFilter === "text" ? "text" : "native";
  const provider = normalizeOptionalLowercaseString(params.provider);

  const skillCommands = await prepareSkillCommandsForAgents({
    cfg: params.cfg,
    agentIds: [params.agentId],
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
  });
  const chatCommands = listChatCommandsForConfig(params.cfg, { skillCommands });
  const skillsByKey = new Map(skillCommands.map((skill) => [`skill:${skill.skillName}`, skill]));

  const commands: CommandEntry[] = [];

  for (const cmd of chatCommands) {
    if (scopeFilter !== "both" && cmd.scope !== "both" && cmd.scope !== scopeFilter) {
      continue;
    }
    if (
      nameSurface === "native" &&
      cmd.scope !== "text" &&
      provider &&
      !supportsNativeProvider(cmd, provider)
    ) {
      continue;
    }
    const skill = skillsByKey.get(cmd.key);
    const baseName = cmd.nativeName ?? cmd.key;
    const nativeName =
      cmd.scope === "text"
        ? undefined
        : provider && cmd.nativeName
          ? (getChannelPlugin(provider)?.commands?.resolveNativeCommandName?.({
              commandKey: cmd.key,
              defaultName: cmd.nativeName,
            }) ?? baseName)
          : baseName;
    let textAliases: string[] | undefined;
    if (cmd.scope !== "native") {
      const aliases = new Set<string>();
      for (const alias of cmd.textAliases) {
        const trimmed = alias.trim();
        if (!trimmed) {
          continue;
        }
        const bounded = truncateUtf16Safe(trimmed, COMMAND_NAME_MAX_LENGTH);
        aliases.add(bounded.startsWith("/") ? bounded : `/${bounded}`);
        if (aliases.size >= COMMAND_ALIAS_MAX_ITEMS) {
          break;
        }
      }
      textAliases =
        aliases.size > 0
          ? [...aliases]
          : [`/${truncateUtf16Safe(cmd.key, COMMAND_NAME_MAX_LENGTH)}`];
    }
    commands.push({
      name: truncateUtf16Safe(
        nameSurface === "text" ? (textAliases?.[0]?.slice(1) ?? cmd.key) : (nativeName ?? cmd.key),
        COMMAND_NAME_MAX_LENGTH,
      ),
      ...(nativeName ? { nativeName: truncateUtf16Safe(nativeName, COMMAND_NAME_MAX_LENGTH) } : {}),
      ...(textAliases ? { textAliases } : {}),
      description: truncateUtf16Safe(cmd.description ?? "", COMMAND_DESCRIPTION_MAX_LENGTH),
      // The v2026.8.1 SDK category remains accepted, but clients use the current Tools group.
      ...(cmd.category ? { category: cmd.category === "docks" ? "tools" : cmd.category } : {}),
      source: skill ? "skill" : "native",
      scope: cmd.scope,
      acceptsArgs: Boolean(cmd.acceptsArgs),
      ...(includeArgs && cmd.acceptsArgs && cmd.args?.length
        ? {
            args: cmd.args.slice(0, COMMAND_ARGS_MAX_ITEMS).map((arg) => ({
              name: truncateUtf16Safe(arg.name, COMMAND_ARG_NAME_MAX_LENGTH),
              description: truncateUtf16Safe(arg.description, COMMAND_ARG_DESCRIPTION_MAX_LENGTH),
              type: arg.type,
              ...(arg.required ? { required: true } : {}),
              ...(Array.isArray(arg.choices)
                ? {
                    choices: arg.choices.slice(0, COMMAND_ARG_CHOICES_MAX_ITEMS).map((choice) => ({
                      value: truncateUtf16Safe(
                        typeof choice === "string" ? choice : choice.value,
                        COMMAND_CHOICE_VALUE_MAX_LENGTH,
                      ),
                      label: truncateUtf16Safe(
                        typeof choice === "string" ? choice : choice.label,
                        COMMAND_CHOICE_LABEL_MAX_LENGTH,
                      ),
                    })),
                  }
                : {}),
              ...(typeof arg.choices === "function" ? { dynamic: true } : {}),
            })),
          }
        : {}),
      ...(skill
        ? {
            skillDisplayName: truncateUtf16Safe(
              skill.displayName ?? skill.skillName,
              COMMAND_NAME_MAX_LENGTH,
            ),
            skillModelVisible: skill.modelVisible !== false,
          }
        : {}),
    });
  }

  const gatewayRegistry = getPluginRegistryForContext();
  const pluginSpecs = gatewayRegistry
    ? getPluginCommandEntrySpecsFromRegistrations(gatewayRegistry.commands, provider, {
        config: params.cfg,
      })
    : getPluginCommandEntrySpecs(provider, { config: params.cfg });
  for (const spec of pluginSpecs) {
    if (nameSurface === "native" && !spec.nativeName) {
      continue;
    }
    commands.push({
      name: truncateUtf16Safe(
        nameSurface === "text" ? spec.name : (spec.nativeName ?? spec.name),
        COMMAND_NAME_MAX_LENGTH,
      ),
      ...(spec.nativeName
        ? { nativeName: truncateUtf16Safe(spec.nativeName, COMMAND_NAME_MAX_LENGTH) }
        : {}),
      textAliases: [`/${truncateUtf16Safe(spec.name, COMMAND_NAME_MAX_LENGTH)}`],
      description: truncateUtf16Safe(spec.description ?? "", COMMAND_DESCRIPTION_MAX_LENGTH),
      source: "plugin",
      scope: "both",
      acceptsArgs: spec.acceptsArgs,
      ...(spec.clientPresentation ? { clientPresentation: spec.clientPresentation } : {}),
    });
  }

  return { commands: commands.slice(0, COMMAND_LIST_MAX_ITEMS) };
}
