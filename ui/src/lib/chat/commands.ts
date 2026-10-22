import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { CommandEntry } from "../../../../packages/gateway-protocol/src/index.js";
import type { CommandArgValues } from "../../../../src/auto-reply/commands-args.types.js";
import {
  buildBuiltinChatCommands,
  shouldForwardModelCommandToServer,
} from "../../../../src/auto-reply/commands-registry.shared.js";
import type { ChatCommandDefinition } from "../../../../src/auto-reply/commands-registry.types.js";
import {
  isModelIndependentDirectiveCommand,
  resolveReplyDirectiveCommand,
} from "../../../../src/auto-reply/reply/directive-handling.parse.js";
import type { IconName } from "../../components/icon-data.ts";
import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";

registerCommandPaletteEnglish();

export type SlashCommandCategory = "session" | "model" | "agents" | "tools";

type SlashCommandTier = "essential" | "standard" | "power";

export type SlashCommandDef = {
  key: string;
  name: string;
  aliases?: string[];
  description: string;
  descriptionKey?: string;
  args?: string;
  icon?: IconName;
  category?: SlashCommandCategory;
  /** When true, the command is executed client-side via RPC instead of sent to the agent. */
  executeLocal?: boolean;
  modelIndependent?: ChatCommandDefinition["modelIndependent"];
  /** Fixed argument choices for inline hints. */
  argOptions?: string[];
  /** Whether a multi-word argument may execute from an inline prose position. */
  allowsInlineMultiWordArgs?: boolean;
  /** Progressive disclosure tier. Defaults to "standard" when omitted. */
  tier?: SlashCommandTier;
  source?: "native" | "plugin" | "skill";
  skillDisplayName?: string;
  skillModelVisible?: boolean;
  clientPresentation?: NonNullable<CommandEntry["clientPresentation"]>;
};

type LocalArgChoice = string | { value: string; label: string };

type CommandLike = {
  key: string;
  name: string;
  aliases?: string[];
  description: string;
  modelIndependent?: ChatCommandDefinition["modelIndependent"];
  args?: Array<{
    name: string;
    required?: boolean;
    choices?: NonNullable<ChatCommandDefinition["args"]>[number]["choices"];
  }>;
  formatArgs?: (values: CommandArgValues) => string | undefined;
  category?: string;
  tier?: string;
  source?: "native" | "plugin" | "skill";
  skillDisplayName?: string;
  skillModelVisible?: boolean;
  clientPresentation?: NonNullable<CommandEntry["clientPresentation"]>;
};

export function executesInlineImmediately(command: SlashCommandDef): boolean {
  return command.source !== "skill";
}

const REMOTE_SLASH_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

const COMMAND_PRESENTATION: Partial<Record<string, Pick<SlashCommandDef, "icon" | "category">>> = {
  help: { icon: "book", category: "tools" },
  status: { icon: "barChart", category: "tools" },
  usage: { icon: "barChart", category: "tools" },
  export: { icon: "download" },
  export_session: { icon: "download", category: "tools" },
  tools: { icon: "terminal", category: "tools" },
  dashboard: { icon: "layoutDashboard" },
  skill: { icon: "zap", category: "tools" },
  commands: { icon: "book", category: "tools" },
  new: { icon: "plus", category: "session" },
  reset: { icon: "refresh", category: "session" },
  compact: { icon: "loader", category: "session" },
  stop: { icon: "stop", category: "session" },
  clear: { icon: "trash" },
  model: { icon: "brain", category: "model" },
  models: { icon: "brain", category: "model" },
  think: { icon: "brain", category: "model" },
  verbose: { icon: "terminal", category: "model" },
  fast: { icon: "zap", category: "model" },
  agents: { icon: "monitor", category: "agents" },
  subagents: { icon: "folder", category: "agents" },
  steer: { icon: "send", category: "agents" },
  tts: { icon: "volume2", category: "tools" },
  redirect: { category: "agents" },
  session: { category: "session" },
  reasoning: { category: "model" },
  elevated: { category: "model" },
  queue: { category: "model" },
};

const INLINE_MULTI_WORD_COMMANDS = new Set(["dashboard"]);

const LOCAL_COMMANDS = new Set([
  "btw",
  "help",
  "new",
  "reset",
  "stop",
  "compact",
  "model",
  "think",
  "fast",
  "verbose",
  "export-session",
  "usage",
  "agents",
  "steer",
  "redirect",
]);

const UI_ONLY_COMMANDS: SlashCommandDef[] = [
  {
    key: "clear",
    name: "clear",
    description: "Clear chat history",
    descriptionKey: "chat.commands.clearDescription",
    icon: "trash",
    category: "session",
    executeLocal: true,
    modelIndependent: "always",
    tier: "standard",
  },
  {
    key: "redirect",
    name: "redirect",
    description: "Abort and restart with a new message",
    descriptionKey: "chat.commands.redirectDescription",
    args: "<message>",
    icon: "refresh",
    category: "agents",
    executeLocal: true,
    modelIndependent: "no-args",
    tier: "power",
  },
];

const COMMAND_OVERRIDES: Partial<
  Record<string, Pick<SlashCommandDef, "description" | "descriptionKey" | "args">>
> = {
  steer: {
    description: registerCommandPaletteEnglish.catalog.chat.commands.steerDescription,
    descriptionKey: "chat.commands.steerDescription",
    args: "<message>",
  },
  "export-session": {
    description: registerCommandPaletteEnglish.catalog.chat.commands.exportDescription,
    descriptionKey: "chat.commands.exportDescription",
    args: undefined,
  },
};

function choiceToValue(command: CommandLike, argName: string, choice: LocalArgChoice): string {
  const value = typeof choice === "string" ? choice : choice.value;
  return command.formatArgs?.({ [argName]: value }) ?? value;
}

function getArgOptions(command: CommandLike): string[] | undefined {
  const firstArg = command.args?.[0];
  if (!firstArg || !Array.isArray(firstArg.choices)) {
    return undefined;
  }
  const options = firstArg.choices
    .map((choice) => choiceToValue(command, firstArg.name, choice))
    .filter(Boolean);
  return options.length ? options : undefined;
}

function mapTier(command: CommandLike): SlashCommandTier {
  const raw = command.tier;
  if (raw === "essential" || raw === "standard" || raw === "power") {
    return raw;
  }
  return "standard";
}

function toSlashCommand(command: CommandLike, source: "local" | "remote"): SlashCommandDef | null {
  const name = command.name.trim();
  if (!name) {
    return null;
  }
  const resolvedSource = command.source ?? (source === "local" ? "native" : undefined);
  const presentation = COMMAND_PRESENTATION[command.key.replace(/[:.-]/g, "_")];
  return {
    key: command.key,
    name,
    aliases: (command.aliases ?? [])
      .map((alias) => alias.trim())
      .filter(Boolean)
      .map((alias) => (alias.startsWith("/") ? alias.slice(1) : alias))
      .filter((alias) => alias !== name),
    description: command.description,
    args: command.args?.length
      ? command.args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" ")
      : undefined,
    ...COMMAND_OVERRIDES[command.key],
    icon: presentation?.icon ?? "terminal",
    category:
      presentation?.category ??
      (command.category === "session"
        ? "session"
        : command.category === "options"
          ? "model"
          : "tools"),
    executeLocal: source === "local" && LOCAL_COMMANDS.has(command.key),
    modelIndependent: command.modelIndependent,
    argOptions: getArgOptions(command),
    allowsInlineMultiWordArgs: INLINE_MULTI_WORD_COMMANDS.has(command.key),
    tier: source === "local" ? mapTier(command) : "standard",
    ...(resolvedSource ? { source: resolvedSource } : {}),
    ...(command.skillDisplayName ? { skillDisplayName: command.skillDisplayName } : {}),
    ...(command.skillModelVisible !== undefined
      ? { skillModelVisible: command.skillModelVisible }
      : {}),
    ...(command.clientPresentation ? { clientPresentation: command.clientPresentation } : {}),
  };
}

function normalizeSlashIdentifier(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\//u, "");
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (!normalized || !REMOTE_SLASH_IDENTIFIER_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

export function buildFallbackSlashCommands(): SlashCommandDef[] {
  const builtins = buildBuiltinChatCommands()
    .map((command) =>
      toSlashCommand(
        {
          ...command,
          name: command.textAliases[0]?.replace(/^\//u, "") ?? command.key,
          aliases: command.textAliases,
        },
        "local",
      ),
    )
    .filter((command): command is SlashCommandDef => command !== null);
  return [...builtins, ...UI_ONLY_COMMANDS];
}

export function replaceSlashCommands(next: SlashCommandDef[]) {
  SLASH_COMMANDS.splice(0, SLASH_COMMANDS.length, ...next);
}

export function buildSlashCommandsFromEntries(entries: CommandEntry[]): SlashCommandDef[] {
  const local = buildFallbackSlashCommands();
  const reservedLocalNames = new Set<string>();
  for (const command of local) {
    reservedLocalNames.add(normalizeLowercaseStringOrEmpty(command.name));
    for (const alias of command.aliases ?? []) {
      const normalized = normalizeSlashIdentifier(alias);
      if (normalized) {
        reservedLocalNames.add(normalized);
      }
    }
  }
  const mapped = entries
    .map<CommandLike | null>((entry) => {
      const aliases = (entry.textAliases ?? [])
        .map(normalizeSlashIdentifier)
        .filter((alias): alias is string => Boolean(alias))
        .filter((alias) => !reservedLocalNames.has(alias));
      const primaryName = aliases[0] ?? normalizeSlashIdentifier(entry.name);
      if (!primaryName || reservedLocalNames.has(primaryName)) {
        return null;
      }
      const args = entry.args?.map((arg) => ({
        name: arg.name,
        required: arg.required,
        choices: arg.dynamic ? [] : arg.choices?.filter((choice) => choice.value),
      }));
      return {
        key: primaryName,
        name: primaryName,
        aliases: aliases.map((alias) => `/${alias}`),
        description: entry.description,
        args,
        category: entry.category,
        source: entry.source,
        skillDisplayName: entry.skillDisplayName?.trim() || undefined,
        skillModelVisible: entry.skillModelVisible,
        clientPresentation: entry.source === "plugin" ? entry.clientPresentation : undefined,
      };
    })
    .filter((command): command is CommandLike => command !== null)
    .map((command) => toSlashCommand(command, "remote"))
    .filter((command): command is SlashCommandDef => command !== null);
  const deduped = new Map<string, SlashCommandDef>();
  for (const command of [...local, ...mapped]) {
    const key = normalizeLowercaseStringOrEmpty(command.name);
    if (!key || deduped.has(key)) {
      continue;
    }
    deduped.set(key, command);
  }
  return Array.from(deduped.values());
}

export const SLASH_COMMANDS: SlashCommandDef[] = buildFallbackSlashCommands();

const CATEGORY_ORDER: SlashCommandCategory[] = ["session", "model", "tools", "agents"];

export function getSlashCommandCategoryLabel(category: SlashCommandCategory): string {
  return t(`chat.commands.categories.${category}`);
}

export function getSlashCommandDescription(command: SlashCommandDef): string {
  return command.descriptionKey ? t(command.descriptionKey) : command.description;
}

const TIER_ORDER: Record<SlashCommandTier, number> = {
  essential: 0,
  standard: 1,
  power: 2,
};

const NON_MATCHING_COMMAND_RANK = 4;

function getSlashCommandRelevance(command: SlashCommandDef, filter: string): number {
  const names = [command.name, ...(command.aliases ?? [])].map(normalizeLowercaseStringOrEmpty);
  if (names.some((name) => name === filter)) {
    return 0;
  }
  if (names.some((name) => name.startsWith(filter))) {
    return 1;
  }
  if (names.some((name) => name.includes(filter))) {
    return 2;
  }
  return normalizeLowercaseStringOrEmpty(getSlashCommandDescription(command)).includes(filter)
    ? 3
    : NON_MATCHING_COMMAND_RANK;
}

export function getSlashCommandCompletions(
  filter: string,
  options?: {
    showAll?: boolean;
    inlineOnly?: boolean;
    allowImmediateInlineCommands?: boolean;
  },
): SlashCommandDef[] {
  const lower = normalizeLowercaseStringOrEmpty(filter);
  const showAll = options?.showAll ?? false;
  let commands = options?.inlineOnly
    ? SLASH_COMMANDS.filter(
        (command) =>
          (command.source === "skill" && command.skillModelVisible === true) ||
          (executesInlineImmediately(command) && options.allowImmediateInlineCommands !== false),
      )
    : SLASH_COMMANDS;
  commands = lower
    ? commands.filter(
        (command) => getSlashCommandRelevance(command, lower) < NON_MATCHING_COMMAND_RANK,
      )
    : commands;

  if (!lower && !showAll) {
    commands = commands.filter((cmd) => (cmd.tier ?? "standard") !== "power");
  }

  return commands.toSorted(
    (a, b) =>
      (lower ? getSlashCommandRelevance(a, lower) - getSlashCommandRelevance(b, lower) : 0) ||
      (TIER_ORDER[a.tier ?? "standard"] ?? 1) - (TIER_ORDER[b.tier ?? "standard"] ?? 1) ||
      CATEGORY_ORDER.indexOf(a.category ?? "session") -
        CATEGORY_ORDER.indexOf(b.category ?? "session"),
  );
}

export type InlineSlashCompletion = {
  query: string;
  start: number;
  end: number;
  inline: boolean;
  skillOnly?: boolean;
  argumentStart?: number;
};

/** Finds the slash token being edited at the caret, including inside normal prose. */
export function findInlineSlashCompletion(
  text: string,
  caret = text.length,
): InlineSlashCompletion | null {
  const boundedCaret = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, boundedCaret);
  const match = prefix.match(/(?:^|\s)\/([^\s/:]*)(:?)$/u);
  if (!match || match.index === undefined) {
    return null;
  }
  const slashOffset = match[0].indexOf("/");
  const start = match.index + slashOffset;
  if (text[start + 1] === "/") {
    return null;
  }
  let end = boundedCaret;
  while (end < text.length && !/\s/u.test(text[end] ?? "")) {
    end += 1;
  }
  const query = match[1] ?? "";
  return {
    query,
    start,
    end,
    inline:
      text.slice(0, start).trim().length > 0 ||
      text.slice(end).trim().length > 0 ||
      match[2] === ":",
    ...(match[2] === ":" ? { skillOnly: true } : {}),
  };
}

export function getSkillDisplayName(command: SlashCommandDef): string {
  return command.skillDisplayName?.trim() || command.name;
}

export function getSkillCommandCompletions(filter: string): SlashCommandDef[] {
  const lower = normalizeLowercaseStringOrEmpty(filter);
  const normalized = lower.replace(/[\s_]+/gu, "-");
  return SLASH_COMMANDS.filter(
    (command) => command.source === "skill" && command.skillModelVisible === true,
  )
    .filter((command) => {
      const displayName = normalizeLowercaseStringOrEmpty(getSkillDisplayName(command));
      const displayLookup = displayName.replace(/[\s_]+/gu, "-");
      const commandLookup = normalizeLowercaseStringOrEmpty(command.name).replace(/[\s_]+/gu, "-");
      return (
        !lower ||
        displayName.includes(lower) ||
        displayLookup.includes(normalized) ||
        commandLookup.startsWith(normalized) ||
        normalizeLowercaseStringOrEmpty(getSlashCommandDescription(command)).includes(lower)
      );
    })
    .toSorted((left, right) => getSkillDisplayName(left).localeCompare(getSkillDisplayName(right)));
}

type ParsedSlashCommand = {
  command: SlashCommandDef;
  args: string;
};

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
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
  const command = SLASH_COMMANDS.find(
    (cmd) =>
      cmd.name === normalizedName ||
      cmd.aliases?.some((alias) => normalizeLowercaseStringOrEmpty(alias) === normalizedName),
  );
  if (!command) {
    return null;
  }

  return { command, args };
}

/** Stop and approval controls must remain usable while transcript admission is held. */
export function isChatControlCommand(text: string): boolean {
  const key = parseSlashCommand(text)?.command.key;
  return normalizeLowercaseStringOrEmpty(text.trim()) === "/stop" || key === "approve";
}

export function canSubmitBeforeChatHistory(text: string): boolean {
  return !text.trimStart().startsWith("/") || isChatControlCommand(text);
}

export function isModelIndependentChatCommand(text: string): boolean {
  const parsed = parseSlashCommand(text);
  if (!parsed) {
    return false;
  }
  const policy = parsed.command.modelIndependent;
  if (policy === "directive") {
    const name = resolveReplyDirectiveCommand(parsed.command.key);
    return (
      name !== undefined &&
      ((name === "model" && !shouldForwardModelCommandToServer(parsed.args)) ||
        isModelIndependentDirectiveCommand(name, parsed.args))
    );
  }
  return (
    policy === "always" ||
    (policy === "no-args"
      ? parsed.args === ""
      : typeof policy === "function" && policy(parsed.args))
  );
}
