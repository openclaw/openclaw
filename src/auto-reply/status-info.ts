import type { SkillCommandSpec } from "../agents/skills.js";
import { describeToolForVerbose } from "../agents/tool-description-summary.js";
import { normalizeToolName } from "../agents/tool-policy-shared.js";
import type { EffectiveToolInventoryResult } from "../agents/tools-effective-inventory.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { isCommandFlagEnabled } from "../config/commands.js";
import type { OpenClawConfig } from "../config/config.js";
import { listPluginCommands } from "../plugins/commands.js";
import {
  listChatCommands,
  listChatCommandsForConfig,
  type ChatCommandDefinition,
} from "./commands-registry.js";
import type { CommandCategory } from "./commands-registry.types.js";

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  session: "Session",
  options: "Options",
  status: "Status",
  management: "Management",
  media: "Media",
  tools: "Tools",
  docks: "Docks",
};

const CATEGORY_ORDER: CommandCategory[] = [
  "session",
  "options",
  "status",
  "management",
  "media",
  "tools",
  "docks",
];

function groupCommandsByCategory(
  commands: ChatCommandDefinition[],
): Map<CommandCategory, ChatCommandDefinition[]> {
  const grouped = new Map<CommandCategory, ChatCommandDefinition[]>();
  for (const category of CATEGORY_ORDER) {
    grouped.set(category, []);
  }
  for (const command of commands) {
    const category = command.category ?? "tools";
    const list = grouped.get(category) ?? [];
    list.push(command);
    grouped.set(category, list);
  }
  return grouped;
}

export function buildHelpMessage(cfg?: OpenClawConfig): string {
  const lines = ["ℹ️ Help", ""];

  lines.push("Session");
  lines.push("  /new  |  /reset  |  /compact [instructions]  |  /stop");
  lines.push("");

  const optionParts = ["/think <level>", "/model <id>", "/fast status|on|off", "/verbose on|off"];
  if (isCommandFlagEnabled(cfg, "config")) {
    optionParts.push("/config");
  }
  if (isCommandFlagEnabled(cfg, "debug")) {
    optionParts.push("/debug");
  }
  lines.push("Options");
  lines.push(`  ${optionParts.join("  |  ")}`);
  lines.push("");

  lines.push("Status");
  lines.push("  /status  |  /tasks  |  /whoami  |  /context  |  /tools [compact|verbose]");
  lines.push("");

  lines.push("Skills");
  lines.push("  /skill <name> [input]");

  lines.push("");
  lines.push(
    "More: /commands for full list, /tools for available capabilities, /models for provider browsing",
  );

  return lines.join("\n");
}

const COMMANDS_PER_PAGE = 8;

export type CommandsMessageOptions = {
  page?: number;
  surface?: string;
};

export type CommandsMessageResult = {
  text: string;
  totalPages: number;
  currentPage: number;
  hasNext: boolean;
  hasPrev: boolean;
};

type ToolsMessageItem = {
  id: string;
  name: string;
  description: string;
  rawDescription: string;
  source: EffectiveToolInventoryResult["groups"][number]["source"];
  pluginId?: string;
  channelId?: string;
};

function sortToolsMessageItems(items: ToolsMessageItem[]): ToolsMessageItem[] {
  return items.toSorted((a, b) => a.name.localeCompare(b.name));
}

function formatCompactToolEntry(tool: ToolsMessageItem): string {
  if (tool.source === "plugin") {
    return tool.pluginId ? `${tool.id} (${tool.pluginId})` : tool.id;
  }
  if (tool.source === "channel") {
    return tool.channelId ? `${tool.id} (${tool.channelId})` : tool.id;
  }
  return tool.id;
}

function formatVerboseToolDescription(tool: ToolsMessageItem): string {
  return describeToolForVerbose({
    rawDescription: tool.rawDescription,
    fallback: tool.description,
  });
}

export function buildToolsMessage(
  result: EffectiveToolInventoryResult,
  options?: { verbose?: boolean },
): string {
  const groups = result.groups
    .map((group) => ({
      label: group.label,
      tools: sortToolsMessageItems(
        group.tools.map((tool) => ({
          id: normalizeToolName(tool.id),
          name: tool.label,
          description: tool.description || "Tool",
          rawDescription: tool.rawDescription || tool.description || "Tool",
          source: tool.source,
          pluginId: tool.pluginId,
          channelId: tool.channelId,
        })),
      ),
    }))
    .filter((group) => group.tools.length > 0);

  if (groups.length === 0) {
    const lines = [
      "No tools are available for this agent right now.",
      "",
      `Profile: ${result.profile}`,
    ];
    return lines.join("\n");
  }

  const verbose = options?.verbose === true;
  const lines = verbose
    ? [
        "Available tools",
        "",
        `Profile: ${result.profile}`,
        ...(result.agentId ? [`Agent: ${result.agentId}`] : []),
        ...(result.workspaceDir ? [`Workspace: ${result.workspaceDir}`] : []),
        "What this agent can use right now:",
      ]
    : [
        "Available tools",
        "",
        `Profile: ${result.profile}`,
        ...(result.agentId ? [`Agent: ${result.agentId}`] : []),
        ...(result.workspaceDir ? [`Workspace: ${result.workspaceDir}`] : []),
      ];

  for (const group of groups) {
    lines.push("", group.label);
    if (verbose) {
      for (const tool of group.tools) {
        lines.push(`  ${tool.name} - ${formatVerboseToolDescription(tool)}`);
      }
      continue;
    }
    lines.push(`  ${group.tools.map((tool) => formatCompactToolEntry(tool)).join(", ")}`);
  }

  if (verbose) {
    lines.push("", "Tool availability depends on this agent's configuration.");
  } else {
    lines.push("", "Use /tools verbose for descriptions.");
  }
  return lines.join("\n");
}

function formatCommandEntry(command: ChatCommandDefinition): string {
  const primary = command.nativeName
    ? `/${command.nativeName}`
    : command.textAliases[0]?.trim() || `/${command.key}`;
  const seen = new Set<string>();
  const aliases = command.textAliases
    .map((alias) => alias.trim())
    .filter(Boolean)
    .filter((alias) => alias.toLowerCase() !== primary.toLowerCase())
    .filter((alias) => {
      const key = alias.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  const aliasLabel = aliases.length ? ` (${aliases.join(", ")})` : "";
  const scopeLabel = command.scope === "text" ? " [text]" : "";
  return `${primary}${aliasLabel}${scopeLabel} - ${command.description}`;
}

type CommandsListItem = {
  label: string;
  text: string;
};

function buildCommandItems(
  commands: ChatCommandDefinition[],
  pluginCommands: ReturnType<typeof listPluginCommands>,
): CommandsListItem[] {
  const grouped = groupCommandsByCategory(commands);
  const items: CommandsListItem[] = [];

  for (const category of CATEGORY_ORDER) {
    const categoryCommands = grouped.get(category) ?? [];
    if (categoryCommands.length === 0) {
      continue;
    }
    const label = CATEGORY_LABELS[category];
    for (const command of categoryCommands) {
      items.push({ label, text: formatCommandEntry(command) });
    }
  }

  for (const command of pluginCommands) {
    const pluginLabel = command.pluginId ? ` (${command.pluginId})` : "";
    items.push({
      label: "Plugins",
      text: `/${command.name}${pluginLabel} - ${command.description}`,
    });
  }

  return items;
}

function formatCommandList(items: CommandsListItem[]): string {
  const lines: string[] = [];
  let currentLabel: string | null = null;

  for (const item of items) {
    if (item.label !== currentLabel) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(item.label);
      currentLabel = item.label;
    }
    lines.push(`  ${item.text}`);
  }

  return lines.join("\n");
}

export function buildCommandsMessage(
  cfg?: OpenClawConfig,
  skillCommands?: SkillCommandSpec[],
  options?: CommandsMessageOptions,
): string {
  const result = buildCommandsMessagePaginated(cfg, skillCommands, options);
  return result.text;
}

export function buildCommandsMessagePaginated(
  cfg?: OpenClawConfig,
  skillCommands?: SkillCommandSpec[],
  options?: CommandsMessageOptions,
): CommandsMessageResult {
  const page = Math.max(1, options?.page ?? 1);
  const surface = options?.surface?.toLowerCase();
  const prefersPaginatedList = Boolean(
    surface && getChannelPlugin(surface)?.commands?.buildCommandsListChannelData,
  );

  const commands = cfg
    ? listChatCommandsForConfig(cfg, { skillCommands })
    : listChatCommands({ skillCommands });
  const pluginCommands = listPluginCommands();
  const items = buildCommandItems(commands, pluginCommands);

  if (!prefersPaginatedList) {
    const lines = ["ℹ️ Slash commands", ""];
    lines.push(formatCommandList(items));
    lines.push("", "Tip: use /tools verbose for detailed capability descriptions.");
    lines.push("Browse models: /models  |  /models <provider>");
    lines.push("", "More: /tools for available capabilities");
    return {
      text: lines.join("\n").trim(),
      totalPages: 1,
      currentPage: 1,
      hasNext: false,
      hasPrev: false,
    };
  }

  const totalCommands = items.length;
  const totalPages = Math.max(1, Math.ceil(totalCommands / COMMANDS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * COMMANDS_PER_PAGE;
  const endIndex = startIndex + COMMANDS_PER_PAGE;
  const pageItems = items.slice(startIndex, endIndex);

  const lines = [`ℹ️ Commands (${currentPage}/${totalPages})`, ""];
  lines.push(formatCommandList(pageItems));

  return {
    text: lines.join("\n").trim(),
    totalPages,
    currentPage,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
  };
}
