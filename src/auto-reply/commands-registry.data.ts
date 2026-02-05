import { listChannelDocks } from "../channels/dock.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { listThinkingLevels } from "./thinking.js";
import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";
import { t as i18nT, type Locale } from "../i18n/commands.js";
import type {
  ChatCommandDefinition,
  CommandCategory,
  CommandScope,
} from "./commands-registry.types.js";
import { listChannelDocks } from "../channels/dock.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { COMMAND_ARG_FORMATTERS } from "./commands-args.js";
import { listThinkingLevels } from "./thinking.js";

type DefineChatCommandInput = {
  key: string;
  nativeName?: string;
  description: string;
  args?: ChatCommandDefinition["args"];
  argsParsing?: ChatCommandDefinition["argsParsing"];
  formatArgs?: ChatCommandDefinition["formatArgs"];
  argsMenu?: ChatCommandDefinition["argsMenu"];
  acceptsArgs?: boolean;
  textAlias?: string;
  textAliases?: string[];
  scope?: CommandScope;
  category?: CommandCategory;
};

function defineChatCommand(command: DefineChatCommandInput): ChatCommandDefinition {
  const aliases = (command.textAliases ?? (command.textAlias ? [command.textAlias] : []))
    .map((alias) => alias.trim())
    .filter(Boolean);
  const scope =
    command.scope ?? (command.nativeName ? (aliases.length ? "both" : "native") : "text");
  const acceptsArgs = command.acceptsArgs ?? Boolean(command.args?.length);
  const argsParsing = command.argsParsing ?? (command.args?.length ? "positional" : "none");
  return {
    key: command.key,
    nativeName: command.nativeName,
    description: command.description,
    acceptsArgs,
    args: command.args,
    argsParsing,
    formatArgs: command.formatArgs,
    argsMenu: command.argsMenu,
    textAliases: aliases,
    scope,
    category: command.category,
  };
}

type ChannelDock = ReturnType<typeof listChannelDocks>[number];

function defineDockCommand(dock: ChannelDock, locale: Locale = "en"): ChatCommandDefinition {
  return defineChatCommand({
    key: `dock:${dock.id}`,
    nativeName: `dock_${dock.id}`,
    description: i18nT("dock.description", locale, { id: dock.id }),
    textAliases: [`/dock-${dock.id}`, `/dock_${dock.id}`],
    category: "docks",
  });
}

function registerAlias(commands: ChatCommandDefinition[], key: string, ...aliases: string[]): void {
  const command = commands.find((entry) => entry.key === key);
  if (!command) {
    throw new Error(`registerAlias: unknown command key: ${key}`);
  }
  const existing = new Set(command.textAliases.map((alias) => alias.trim().toLowerCase()));
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = trimmed.toLowerCase();
    if (existing.has(lowered)) {
      continue;
    }
    existing.add(lowered);
    command.textAliases.push(trimmed);
  }
}

function assertCommandRegistry(commands: ChatCommandDefinition[]): void {
  const keys = new Set<string>();
  const nativeNames = new Set<string>();
  const textAliases = new Set<string>();
  for (const command of commands) {
    if (keys.has(command.key)) {
      throw new Error(`Duplicate command key: ${command.key}`);
    }
    keys.add(command.key);

    const nativeName = command.nativeName?.trim();
    if (command.scope === "text") {
      if (nativeName) {
        throw new Error(`Text-only command has native name: ${command.key}`);
      }
      if (command.textAliases.length === 0) {
        throw new Error(`Text-only command missing text alias: ${command.key}`);
      }
    } else if (!nativeName) {
      throw new Error(`Native command missing native name: ${command.key}`);
    } else {
      const nativeKey = nativeName.toLowerCase();
      if (nativeNames.has(nativeKey)) {
        throw new Error(`Duplicate native command: ${nativeName}`);
      }
      nativeNames.add(nativeKey);
    }

    if (command.scope === "native" && command.textAliases.length > 0) {
      throw new Error(`Native-only command has text aliases: ${command.key}`);
    }

    for (const alias of command.textAliases) {
      if (!alias.startsWith("/")) {
        throw new Error(`Command alias missing leading '/': ${alias}`);
      }
      const aliasKey = alias.toLowerCase();
      if (textAliases.has(aliasKey)) {
        throw new Error(`Duplicate command alias: ${alias}`);
      }
      textAliases.add(aliasKey);
    }
  }
}

let cachedCommands: ChatCommandDefinition[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let cachedLocale: Locale | null = null;
let cachedNativeCommandSurfaces: Set<string> | null = null;
let cachedNativeRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

function buildChatCommands(locale: Locale = "en"): ChatCommandDefinition[] {
  const t = (key: Parameters<typeof i18nT>[0], replacements?: Record<string, string>) =>
    i18nT(key, locale, replacements);
  const commands: ChatCommandDefinition[] = [
    defineChatCommand({
      key: "help",
      nativeName: "help",
      description: t("help.description"),
      textAlias: "/help",
      category: "status",
    }),
    defineChatCommand({
      key: "commands",
      nativeName: "commands",
      description: t("commands.description"),
      textAlias: "/commands",
      category: "status",
    }),
    defineChatCommand({
      key: "skill",
      nativeName: "skill",
      description: t("skill.description"),
      textAlias: "/skill",
      category: "tools",
      args: [
        {
          name: "name",
          description: t("skill.args.name"),
          type: "string",
          required: true,
        },
        {
          name: "input",
          description: t("skill.args.input"),
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "status",
      nativeName: "status",
      description: t("status.description"),
      textAlias: "/status",
      category: "status",
    }),
    defineChatCommand({
      key: "allowlist",
      description: t("allowlist.description"),
      textAlias: "/allowlist",
      acceptsArgs: true,
      scope: "text",
      category: "management",
    }),
    defineChatCommand({
      key: "approve",
      nativeName: "approve",
      description: t("approve.description"),
      textAlias: "/approve",
      acceptsArgs: true,
      category: "management",
    }),
    defineChatCommand({
      key: "context",
      nativeName: "context",
      description: t("context.description"),
      textAlias: "/context",
      acceptsArgs: true,
      category: "status",
    }),
    defineChatCommand({
      key: "tts",
      nativeName: "tts",
      description: t("tts.description"),
      textAlias: "/tts",
      category: "media",
      args: [
        {
          name: "action",
          description: t("tts.args.action"),
          type: "string",
          choices: [
            { value: "on", label: t("tts.choices.on") },
            { value: "off", label: t("tts.choices.off") },
            { value: "status", label: t("tts.choices.status") },
            { value: "provider", label: t("tts.choices.provider") },
            { value: "limit", label: t("tts.choices.limit") },
            { value: "summary", label: t("tts.choices.summary") },
            { value: "audio", label: t("tts.choices.audio") },
            { value: "help", label: t("tts.choices.help") },
          ],
        },
        {
          name: "value",
          description: t("tts.args.value"),
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: {
        arg: "action",
        title: t("tts.menu.title"),
      },
    }),
    defineChatCommand({
      key: "whoami",
      nativeName: "whoami",
      description: t("whoami.description"),
      textAlias: "/whoami",
      category: "status",
    }),
    defineChatCommand({
      key: "subagents",
      nativeName: "subagents",
      description: t("subagents.description"),
      textAlias: "/subagents",
      category: "management",
      args: [
        {
          name: "action",
          description: t("subagents.args.action"),
          type: "string",
          choices: ["list", "stop", "log", "info", "send"],
        },
        {
          name: "target",
          description: t("subagents.args.target"),
          type: "string",
        },
        {
          name: "value",
          description: t("subagents.args.value"),
          type: "string",
          captureRemaining: true,
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "config",
      nativeName: "config",
      description: t("config.description"),
      textAlias: "/config",
      category: "management",
      args: [
        {
          name: "action",
          description: t("config.args.action"),
          type: "string",
          choices: ["show", "get", "set", "unset"],
        },
        {
          name: "path",
          description: t("config.args.path"),
          type: "string",
        },
        {
          name: "value",
          description: t("config.args.value"),
          type: "string",
          captureRemaining: true,
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.config,
    }),
    defineChatCommand({
      key: "debug",
      nativeName: "debug",
      description: t("debug.description"),
      textAlias: "/debug",
      category: "management",
      args: [
        {
          name: "action",
          description: t("debug.args.action"),
          type: "string",
          choices: ["show", "reset", "set", "unset"],
        },
        {
          name: "path",
          description: t("debug.args.path"),
          type: "string",
        },
        {
          name: "value",
          description: t("debug.args.value"),
          type: "string",
          captureRemaining: true,
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.debug,
    }),
    defineChatCommand({
      key: "usage",
      nativeName: "usage",
      description: t("usage.description"),
      textAlias: "/usage",
      category: "options",
      args: [
        {
          name: "mode",
          description: t("usage.args.mode"),
          type: "string",
          choices: ["off", "tokens", "full", "cost"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "stop",
      nativeName: "stop",
      description: t("stop.description"),
      textAlias: "/stop",
      category: "session",
    }),
    defineChatCommand({
      key: "restart",
      nativeName: "restart",
      description: t("restart.description"),
      textAlias: "/restart",
      category: "tools",
    }),
    defineChatCommand({
      key: "activation",
      nativeName: "activation",
      description: t("activation.description"),
      textAlias: "/activation",
      category: "management",
      args: [
        {
          name: "mode",
          description: t("activation.args.mode"),
          type: "string",
          choices: ["mention", "always"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "send",
      nativeName: "send",
      description: t("send.description"),
      textAlias: "/send",
      category: "management",
      args: [
        {
          name: "mode",
          description: t("send.args.mode"),
          type: "string",
          choices: ["on", "off", "inherit"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "reset",
      nativeName: "reset",
      description: t("reset.description"),
      textAlias: "/reset",
      acceptsArgs: true,
      category: "session",
    }),
    defineChatCommand({
      key: "new",
      nativeName: "new",
      description: t("new.description"),
      textAlias: "/new",
      acceptsArgs: true,
      category: "session",
    }),
    defineChatCommand({
      key: "compact",
      description: t("compact.description"),
      textAlias: "/compact",
      scope: "text",
      category: "session",
      args: [
        {
          name: "instructions",
          description: t("compact.args.instructions"),
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    defineChatCommand({
      key: "think",
      nativeName: "think",
      description: t("think.description"),
      textAlias: "/think",
      category: "options",
      args: [
        {
          name: "level",
          description: t("think.args.level"),
          type: "string",
          choices: ({ provider, model }) => listThinkingLevels(provider, model),
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "verbose",
      nativeName: "verbose",
      description: t("verbose.description"),
      textAlias: "/verbose",
      category: "options",
      args: [
        {
          name: "mode",
          description: t("verbose.args.mode"),
          type: "string",
          choices: ["on", "off"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "reasoning",
      nativeName: "reasoning",
      description: t("reasoning.description"),
      textAlias: "/reasoning",
      category: "options",
      args: [
        {
          name: "mode",
          description: t("reasoning.args.mode"),
          type: "string",
          choices: ["on", "off", "stream"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "elevated",
      nativeName: "elevated",
      description: t("elevated.description"),
      textAlias: "/elevated",
      category: "options",
      args: [
        {
          name: "mode",
          description: t("elevated.args.mode"),
          type: "string",
          choices: ["on", "off", "ask", "full"],
        },
      ],
      argsMenu: "auto",
    }),
    defineChatCommand({
      key: "exec",
      nativeName: "exec",
      description: t("exec.description"),
      textAlias: "/exec",
      category: "options",
      args: [
        {
          name: "options",
          description: t("exec.args.options"),
          type: "string",
        },
      ],
      argsParsing: "none",
    }),
    defineChatCommand({
      key: "model",
      nativeName: "model",
      description: t("model.description"),
      textAlias: "/model",
      category: "options",
      args: [
        {
          name: "model",
          description: t("model.args.model"),
          type: "string",
        },
      ],
    }),
    defineChatCommand({
      key: "models",
      nativeName: "models",
      description: t("models.description"),
      textAlias: "/models",
      argsParsing: "none",
      acceptsArgs: true,
      category: "options",
    }),
    defineChatCommand({
      key: "queue",
      nativeName: "queue",
      description: t("queue.description"),
      textAlias: "/queue",
      category: "options",
      args: [
        {
          name: "mode",
          description: t("queue.args.mode"),
          type: "string",
          choices: ["steer", "interrupt", "followup", "collect", "steer-backlog"],
        },
        {
          name: "debounce",
          description: t("queue.args.debounce"),
          type: "string",
        },
        {
          name: "cap",
          description: t("queue.args.cap"),
          type: "number",
        },
        {
          name: "drop",
          description: t("queue.args.drop"),
          type: "string",
          choices: ["old", "new", "summarize"],
        },
      ],
      argsParsing: "none",
      formatArgs: COMMAND_ARG_FORMATTERS.queue,
    }),
    defineChatCommand({
      key: "bash",
      description: t("bash.description"),
      textAlias: "/bash",
      scope: "text",
      category: "tools",
      args: [
        {
          name: "command",
          description: t("bash.args.command"),
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    ...listChannelDocks()
      .filter((dock) => dock.capabilities.nativeCommands)
      .map((dock) => defineDockCommand(dock, locale)),
  ];

  registerAlias(commands, "whoami", "/id");
  registerAlias(commands, "think", "/thinking", "/t");
  registerAlias(commands, "verbose", "/v");
  registerAlias(commands, "reasoning", "/reason");
  registerAlias(commands, "elevated", "/elev");

  assertCommandRegistry(commands);
  return commands;
}

export function getChatCommands(locale: Locale = "en"): ChatCommandDefinition[] {
  const registry = getActivePluginRegistry();
  if (cachedCommands && registry === cachedRegistry && locale === cachedLocale) {
    return cachedCommands;
  }
  const commands = buildChatCommands(locale);
  cachedCommands = commands;
  cachedRegistry = registry;
  cachedLocale = locale;
  cachedNativeCommandSurfaces = null;
  return commands;
}

export function getNativeCommandSurfaces(): Set<string> {
  const registry = getActivePluginRegistry();
  if (cachedNativeCommandSurfaces && registry === cachedNativeRegistry) {
    return cachedNativeCommandSurfaces;
  }
  cachedNativeCommandSurfaces = new Set(
    listChannelDocks()
      .filter((dock) => dock.capabilities.nativeCommands)
      .map((dock) => dock.id),
  );
  cachedNativeRegistry = registry;
  return cachedNativeCommandSurfaces;
}
