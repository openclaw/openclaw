import { listChannelPlugins } from "../channels/plugins/index.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  assertCommandRegistry,
  buildBuiltinChatCommands,
  defineChatCommand,
} from "./commands-registry.shared.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";

type ChannelPlugin = ReturnType<typeof listChannelPlugins>[number];

function defineDockCommand(plugin: ChannelPlugin): ChatCommandDefinition {
  return defineChatCommand({
    key: `dock:${plugin.id}`,
    nativeName: `dock_${plugin.id}`,
    description: `Switch to ${plugin.id} for replies.`,
    textAliases: [`/dock-${plugin.id}`, `/dock_${plugin.id}`],
    category: "docks",
  });
}

let cachedCommands: ChatCommandDefinition[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let cachedNativeCommandSurfaces: Set<string> | null = null;
let cachedNativeRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function buildChatCommands(): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [
    ...buildBuiltinChatCommands(),
    defineChatCommand({
      key: "trust",
      nativeName: "trust",
      description: "Trust all exec in this session for X minutes (set exec security to full), default 15m, max 480m",
      textAlias: "/trust",
      category: "options",
      args: [
        {
          name: "minutes",
          description: "trust duration in minutes (1-480, default 15)",
          type: "number",
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "untrust",
      nativeName: "untrust",
      description: "End trust window for this session",
      textAlias: "/untrust",
      category: "options",
    }),
    ...listChannelPlugins()
      .filter((plugin) => plugin.capabilities.nativeCommands)
      .map((plugin) => defineDockCommand(plugin)),
  ];

  assertCommandRegistry(commands);
  return commands;
}

export function getChatCommands(): ChatCommandDefinition[] {
  const registry = getActivePluginRegistry();
  if (cachedCommands && registry === cachedRegistry) {
    return cachedCommands;
  }
  const commands = buildChatCommands();
  cachedCommands = commands;
  cachedRegistry = registry;
  cachedNativeCommandSurfaces = null;
  return commands;
}

export function getNativeCommandSurfaces(): Set<string> {
  const registry = getActivePluginRegistry();
  if (cachedNativeCommandSurfaces && registry === cachedNativeRegistry) {
    return cachedNativeCommandSurfaces;
  }
  cachedNativeCommandSurfaces = new Set(
    listChannelPlugins()
      .filter((plugin) => plugin.capabilities.nativeCommands)
      .map((plugin) => plugin.id),
  );
  cachedNativeRegistry = registry;
  return cachedNativeCommandSurfaces;
}
