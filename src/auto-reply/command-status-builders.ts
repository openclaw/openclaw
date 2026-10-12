/** Formats /help and /commands output for text and native command-list surfaces. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { isCommandFlagEnabled } from "../config/commands.flags.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listPluginCommands } from "../plugins/commands.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { SkillCommandSpec } from "../skills/types.js";
import {
  listChatCommands,
  listChatCommandsForConfig,
  type ChatCommandDefinition,
} from "./commands-registry.js";

const COMMAND_CATEGORIES = [
  ["session", "Session"],
  ["options", "Options"],
  ["status", "Status"],
  ["management", "Management"],
  ["media", "Media"],
  ["tools", "Tools"],
] as const;
type DisplayCategory = (typeof COMMAND_CATEGORIES)[number][0];

/** Builds the compact slash-command help text shown by `/help`. */
export function buildHelpMessage(cfg?: OpenClawConfig): string {
  const optionParts = [
    "/think <level|default>",
    "/model <id>",
    "/fast status|auto|on|off|ultrafast|default",
    "/verbose on|off|full",
    "/trace on|off|raw",
  ];
  for (const key of ["config", "debug"] as const) {
    if (isCommandFlagEnabled(cfg, key)) {
      optionParts.push(`/${key}`);
    }
  }
  return [
    "ℹ️ Help",
    "",
    "Session",
    "  /new  |  /reset  |  /compact [instructions]  |  /stop",
    "",
    "Options",
    `  ${optionParts.join("  |  ")}`,
    "",
    "Status",
    "  /status  |  /whoami  |  /context",
    "",
    "Skills",
    "  /skill <name> [input]",
    "",
    "More: /commands for full list, /tools for available capabilities",
  ].join("\n");
}

const COMMANDS_PER_PAGE = 8;

/** Options for rendering `/commands` output for a specific channel surface. */
export type CommandsMessageOptions = {
  page?: number;
  surface?: string;
  forcePaginatedList?: boolean;
};

/** Rendered `/commands` text plus pagination metadata for channel-native lists. */
export type CommandsMessageResult = {
  text: string;
  totalPages: number;
  currentPage: number;
  hasNext: boolean;
  hasPrev: boolean;
};

function formatCommandEntry(command: ChatCommandDefinition): string {
  const primary = command.nativeName
    ? `/${command.nativeName}`
    : normalizeOptionalString(command.textAliases[0]) || `/${command.key}`;
  const aliases = dedupeByKey(
    command.textAliases
      .map((alias) => alias.trim())
      .filter(Boolean)
      .filter(
        (alias) =>
          normalizeLowercaseStringOrEmpty(alias) !== normalizeLowercaseStringOrEmpty(primary),
      ),
    normalizeLowercaseStringOrEmpty,
  );
  const aliasLabel = aliases.length ? ` (${aliases.join(", ")})` : "";
  const scopeLabel = command.scope === "text" ? " [text]" : "";
  return `${primary}${aliasLabel}${scopeLabel} - ${command.description}`;
}

/** Builds `/commands` text, returning only the rendered message body. */
export function buildCommandsMessage(
  cfg?: OpenClawConfig,
  skillCommands?: SkillCommandSpec[],
  options?: CommandsMessageOptions,
): string {
  return buildCommandsMessagePaginated(cfg, skillCommands, options).text;
}

/** Builds `/commands` text and pagination metadata for surfaces with native list controls. */
export function buildCommandsMessagePaginated(
  cfg?: OpenClawConfig,
  skillCommands?: SkillCommandSpec[],
  options?: CommandsMessageOptions,
): CommandsMessageResult {
  const page = Math.max(1, options?.page ?? 1);
  const surface = normalizeOptionalLowercaseString(options?.surface);
  // Surfaces with native command-list UI need page metadata; plain text surfaces get one full list.
  const prefersPaginatedList =
    options?.forcePaginatedList === true ||
    Boolean(surface && getChannelPlugin(surface)?.commands?.buildCommandsListChannelData);

  const commands = cfg
    ? listChatCommandsForConfig(cfg, { skillCommands })
    : listChatCommands({ skillCommands });
  const pluginCommands = listPluginCommands();
  const grouped = new Map<DisplayCategory, ChatCommandDefinition[]>();
  for (const command of commands) {
    const category = command.category === "docks" ? "tools" : (command.category ?? "tools");
    const list = grouped.get(category) ?? [];
    list.push(command);
    grouped.set(category, list);
  }
  const items: Array<{ label: string; text: string }> = [];

  for (const [category, label] of COMMAND_CATEGORIES) {
    for (const command of grouped.get(category) ?? []) {
      items.push({ label, text: formatCommandEntry(command) });
    }
  }

  for (const command of pluginCommands) {
    const pluginLabel = command.pluginId ? ` (${command.pluginId})` : "";
    // Preserve the canonical spelling without auto-linking only its prefix or guessing an alias.
    const commandName = command.name.includes("-") ? `\`/${command.name}\`` : `/${command.name}`;
    items.push({
      label: "Plugins",
      text: `${commandName}${pluginLabel} - ${command.description}`,
    });
  }

  const totalPages = prefersPaginatedList
    ? Math.max(1, Math.ceil(items.length / COMMANDS_PER_PAGE))
    : 1;
  const currentPage = prefersPaginatedList ? Math.min(page, totalPages) : 1;
  const startIndex = (currentPage - 1) * COMMANDS_PER_PAGE;
  const pageItems = prefersPaginatedList
    ? items.slice(startIndex, startIndex + COMMANDS_PER_PAGE)
    : items;
  const itemLines: string[] = [];
  for (const [index, item] of pageItems.entries()) {
    if (item.label !== pageItems[index - 1]?.label) {
      if (itemLines.length > 0) {
        itemLines.push("");
      }
      itemLines.push(item.label);
    }
    itemLines.push(`  ${item.text}`);
  }
  const lines = [
    prefersPaginatedList ? `ℹ️ Commands (${currentPage}/${totalPages})` : "ℹ️ Slash commands",
    "",
    itemLines.join("\n"),
  ];
  if (!prefersPaginatedList) {
    lines.push("", "More: /tools for available capabilities");
  }

  return {
    text: lines.join("\n").trim(),
    totalPages,
    currentPage,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
  };
}
