import { buildBuiltinChatCommands } from "../../../../src/auto-reply/commands-registry.shared.js";
import type {
  ChatCommandDefinition,
  CommandArgChoice,
} from "../../../../src/auto-reply/commands-registry.types.js";
import type { IconName } from "../icons.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { CommandCatalogEntry, CommandCatalogResult } from "../types.ts";

export type SlashCommandCategory = "session" | "model" | "agents" | "tools";

export type SlashCommandDef = {
  key: string;
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  icon?: IconName;
  category?: SlashCommandCategory;
  /** When true, the command is executed client-side via RPC instead of sent to the agent. */
  executeLocal?: boolean;
  /** Fixed argument choices for inline hints. */
  argOptions?: string[];
  /** Keyboard shortcut hint shown in the menu (display only). */
  shortcut?: string;
};

const COMMAND_ICON_OVERRIDES: Partial<Record<string, IconName>> = {
  help: "book",
  status: "barChart",
  usage: "barChart",
  export: "download",
  export_session: "download",
  tools: "terminal",
  skill: "zap",
  commands: "book",
  new: "plus",
  reset: "refresh",
  compact: "loader",
  stop: "stop",
  clear: "trash",
  focus: "eye",
  unfocus: "eye",
  model: "brain",
  models: "brain",
  think: "brain",
  verbose: "terminal",
  fast: "zap",
  agents: "monitor",
  subagents: "folder",
  kill: "x",
  steer: "send",
  tts: "volume2",
};

const LOCAL_COMMANDS = new Set([
  "help",
  "new",
  "reset",
  "stop",
  "compact",
  "focus",
  "model",
  "think",
  "fast",
  "verbose",
  "export-session",
  "usage",
  "agents",
  "kill",
  "steer",
  "redirect",
]);

const UI_ONLY_COMMANDS: SlashCommandDef[] = [
  {
    key: "clear",
    name: "clear",
    description: "Clear chat history",
    icon: "trash",
    category: "session",
    executeLocal: true,
  },
  {
    key: "redirect",
    name: "redirect",
    description: "Abort and restart with a new message",
    args: "[id] <message>",
    icon: "refresh",
    category: "agents",
    executeLocal: true,
  },
];

const CATEGORY_OVERRIDES: Partial<Record<string, SlashCommandCategory>> = {
  help: "tools",
  commands: "tools",
  tools: "tools",
  skill: "tools",
  status: "tools",
  export_session: "tools",
  usage: "tools",
  tts: "tools",
  agents: "agents",
  subagents: "agents",
  kill: "agents",
  steer: "agents",
  redirect: "agents",
  session: "session",
  stop: "session",
  reset: "session",
  new: "session",
  compact: "session",
  focus: "session",
  unfocus: "session",
  model: "model",
  models: "model",
  think: "model",
  verbose: "model",
  fast: "model",
  reasoning: "model",
  elevated: "model",
  queue: "model",
};

const COMMAND_DESCRIPTION_OVERRIDES: Partial<Record<string, string>> = {
  steer: "Inject a message into the active run",
};

const COMMAND_ARGS_OVERRIDES: Partial<Record<string, string>> = {
  steer: "[id] <message>",
};

function normalizeUiKey(command: ChatCommandDefinition): string {
  return command.key.replace(/[:.-]/g, "_");
}

function normalizeCatalogKey(key: string): string {
  return key.replace(/[:.-]/g, "_");
}

function getSlashAliases(command: ChatCommandDefinition): string[] {
  return command.textAliases
    .map((alias) => alias.trim())
    .filter((alias) => alias.startsWith("/"))
    .map((alias) => alias.slice(1));
}

function getPrimarySlashName(command: ChatCommandDefinition): string | null {
  const aliases = getSlashAliases(command);
  if (aliases.length === 0) {
    return null;
  }
  return aliases[0] ?? null;
}

function getCatalogAliases(entry: CommandCatalogEntry): string[] {
  return (entry.textAliases ?? [])
    .map((alias) => alias.trim())
    .filter((alias) => alias.startsWith("/"))
    .map((alias) => alias.slice(1))
    .filter((alias) => alias !== entry.name);
}

function formatArgs(command: {
  args?: Array<{ name: string; required?: boolean }>;
}): string | undefined {
  if (!command.args?.length) {
    return undefined;
  }
  return command.args
    .map((arg) => {
      const token = `<${arg.name}>`;
      return arg.required ? token : `[${arg.name}]`;
    })
    .join(" ");
}

function choiceToValue(choice: CommandArgChoice): string {
  return typeof choice === "string" ? choice : choice.value;
}

function getArgOptions(command: ChatCommandDefinition): string[] | undefined {
  const firstArg = command.args?.[0];
  if (!firstArg || typeof firstArg.choices === "function") {
    return undefined;
  }
  const options = firstArg.choices?.map(choiceToValue).filter(Boolean);
  return options?.length ? options : undefined;
}

function getCatalogArgOptions(entry: CommandCatalogEntry): string[] | undefined {
  const options = entry.args?.[0]?.choices?.map((choice) => choice.value).filter(Boolean);
  return options?.length ? options : undefined;
}

function mapCategory(command: ChatCommandDefinition): SlashCommandCategory {
  return CATEGORY_OVERRIDES[normalizeUiKey(command)] ?? "tools";
}

function mapCategoryFromCatalogEntry(entry: CommandCatalogEntry): SlashCommandCategory {
  return (
    CATEGORY_OVERRIDES[normalizeCatalogKey(entry.name)] ??
    (entry.category === "session" ? "session" : entry.category === "options" ? "model" : "tools")
  );
}

function mapIcon(command: ChatCommandDefinition): IconName | undefined {
  return COMMAND_ICON_OVERRIDES[normalizeUiKey(command)] ?? "terminal";
}

function mapIconFromCatalogEntry(entry: CommandCatalogEntry): IconName | undefined {
  return COMMAND_ICON_OVERRIDES[normalizeCatalogKey(entry.name)] ?? "terminal";
}

function toSlashCommand(command: ChatCommandDefinition): SlashCommandDef | null {
  const name = getPrimarySlashName(command);
  if (!name) {
    return null;
  }
  return {
    key: command.key,
    name,
    aliases: getSlashAliases(command).filter((alias) => alias !== name),
    description: COMMAND_DESCRIPTION_OVERRIDES[command.key] ?? command.description,
    args: COMMAND_ARGS_OVERRIDES[command.key] ?? formatArgs(command),
    icon: mapIcon(command),
    category: mapCategory(command),
    executeLocal: LOCAL_COMMANDS.has(command.key),
    argOptions: getArgOptions(command),
  };
}

function toSlashCommandFromCatalogEntry(entry: CommandCatalogEntry): SlashCommandDef {
  const normalizedKey = normalizeCatalogKey(entry.name);
  return {
    key: entry.name,
    name: entry.name,
    aliases: getCatalogAliases(entry),
    description: COMMAND_DESCRIPTION_OVERRIDES[normalizedKey] ?? entry.description,
    args: COMMAND_ARGS_OVERRIDES[normalizedKey] ?? formatArgs(entry),
    icon: mapIconFromCatalogEntry(entry),
    category: mapCategoryFromCatalogEntry(entry),
    executeLocal: LOCAL_COMMANDS.has(entry.name),
    argOptions: getCatalogArgOptions(entry),
  };
}

const BUILTIN_SLASH_COMMANDS: SlashCommandDef[] = buildBuiltinChatCommands()
  .map(toSlashCommand)
  .filter((command): command is SlashCommandDef => command !== null);

export const SLASH_COMMANDS: SlashCommandDef[] = [...BUILTIN_SLASH_COMMANDS, ...UI_ONLY_COMMANDS];

const CATEGORY_ORDER: SlashCommandCategory[] = ["session", "model", "tools", "agents"];

export const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  session: "Session",
  model: "Model",
  agents: "Agents",
  tools: "Tools",
};

function dedupeSlashCommands(commands: SlashCommandDef[]): SlashCommandDef[] {
  const seen = new Set<string>();
  const deduped: SlashCommandDef[] = [];
  for (const command of commands) {
    const key = normalizeLowercaseStringOrEmpty(command.name);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(command);
  }
  return deduped;
}

export function resolveSlashCommands(
  commandCatalog?: readonly CommandCatalogEntry[] | CommandCatalogResult | null,
): SlashCommandDef[] {
  let commands: readonly CommandCatalogEntry[] | undefined;
  if (Array.isArray(commandCatalog)) {
    commands = commandCatalog;
  } else if (commandCatalog && "commands" in commandCatalog) {
    commands = commandCatalog.commands;
  }
  if (!commands?.length) {
    return SLASH_COMMANDS;
  }
  return dedupeSlashCommands([
    ...UI_ONLY_COMMANDS,
    ...commands.map(toSlashCommandFromCatalogEntry),
  ]);
}

export function getSlashCommandCompletions(
  filter: string,
  availableCommands?: readonly SlashCommandDef[] | null,
): SlashCommandDef[] {
  const available = availableCommands?.length ? [...availableCommands] : SLASH_COMMANDS;
  const lower = normalizeLowercaseStringOrEmpty(filter);
  const commands = lower
    ? available.filter(
        (cmd) =>
          cmd.name.startsWith(lower) ||
          cmd.aliases?.some((alias) => normalizeLowercaseStringOrEmpty(alias).startsWith(lower)) ||
          normalizeLowercaseStringOrEmpty(cmd.description).includes(lower),
      )
    : available;
  return commands.toSorted((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category ?? "session");
    const bi = CATEGORY_ORDER.indexOf(b.category ?? "session");
    if (ai !== bi) {
      return ai - bi;
    }
    if (lower) {
      const aExact = a.name.startsWith(lower) ? 0 : 1;
      const bExact = b.name.startsWith(lower) ? 0 : 1;
      if (aExact !== bExact) {
        return aExact - bExact;
      }
    }
    return 0;
  });
}

export type ParsedSlashCommand = {
  command: SlashCommandDef;
  args: string;
};

export function parseSlashCommand(
  text: string,
  availableCommands?: readonly SlashCommandDef[] | null,
): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const body = trimmed.slice(1);
  const firstSeparator = body.search(/[\s:]/u);
  const name = firstSeparator === -1 ? body : body.slice(0, firstSeparator);
  let remainder = firstSeparator === -1 ? "" : body.slice(firstSeparator).trimStart();
  if (remainder.startsWith(":")) {
    remainder = remainder.slice(1).trimStart();
  }
  const args = remainder.trim();

  if (!name) {
    return null;
  }

  const normalizedName = normalizeLowercaseStringOrEmpty(name);
  const commands = availableCommands?.length ? availableCommands : SLASH_COMMANDS;
  const command = commands.find(
    (cmd) =>
      cmd.name === normalizedName ||
      cmd.aliases?.some((alias) => normalizeLowercaseStringOrEmpty(alias) === normalizedName),
  );
  if (!command) {
    return null;
  }

  return { command, args };
}
