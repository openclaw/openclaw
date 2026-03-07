import { describeToolForVerbose } from "../agents/tool-description-summary.js";
import { normalizeToolName } from "../agents/tool-policy-shared.js";
import type { EffectiveToolInventoryResult } from "../agents/tools-effective-inventory.types.js";
export {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  type CommandsMessageOptions,
  type CommandsMessageResult,
} from "./command-status-builders.js";
export {
  buildStatusMessage,
  formatContextUsageShort,
  formatTokenCount,
  type StatusArgs,
} from "../status/status-message.js";

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
    ? ["Available tools", "", `Profile: ${result.profile}`, "What this agent can use right now:"]
    : ["Available tools", "", `Profile: ${result.profile}`];

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
  if (result.notices?.length) {
    lines.push("", "Notes");
    for (const notice of result.notices) {
      lines.push(`  ${notice.message}`);
    }
  }
  return lines.join("\n");
}
  const selectedModelLabel = modelRefs.selected.label || "unknown";
  const activeModelLabel = formatProviderModelRef(activeProvider, activeModel) || "unknown";
  const fallbackState = resolveActiveFallbackState({
    selectedModelRef: selectedModelLabel,
    activeModelRef: activeModelLabel,
    state: entry,
  });
  const effectiveCostAuthMode = fallbackState.active
    ? activeAuthMode
    : (selectedAuthMode ?? activeAuthMode);
  const showCost = effectiveCostAuthMode === "api-key" || effectiveCostAuthMode === "mixed";
  const costConfig = showCost
    ? resolveModelCostConfig({
        provider: activeProvider,
        model: activeModel,
        config: args.config,
      })
    : undefined;
  const hasUsage = typeof inputTokens === "number" || typeof outputTokens === "number";
  const cost =
    showCost && hasUsage
      ? estimateUsageCost({
          usage: {
            input: inputTokens ?? undefined,
            output: outputTokens ?? undefined,
          },
          cost: costConfig,
        })
      : undefined;
  const costLabel = showCost && hasUsage ? formatUsd(cost) : undefined;

  const selectedAuthLabel = selectedAuthLabelValue ? ` · 🔑 ${selectedAuthLabelValue}` : "";
  const channelModelNote = (() => {
    if (!args.config || !entry) {
      return undefined;
    }
    if (entry.modelOverride?.trim() || entry.providerOverride?.trim()) {
      return undefined;
    }
    const channelOverride = resolveChannelModelOverride({
      cfg: args.config,
      channel: entry.channel ?? entry.origin?.provider,
      groupId: entry.groupId,
      groupChannel: entry.groupChannel,
      groupSubject: entry.subject,
      parentSessionKey: args.parentSessionKey,
    });
    if (!channelOverride) {
      return undefined;
    }
    const aliasIndex = buildModelAliasIndex({
      cfg: args.config,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const resolvedOverride = resolveModelRefFromString({
      raw: channelOverride.model,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!resolvedOverride) {
      return undefined;
    }
    if (
      resolvedOverride.ref.provider !== selectedProvider ||
      resolvedOverride.ref.model !== selectedModel
    ) {
      return undefined;
    }
    return "channel override";
  })();
  const modelNote = channelModelNote ? ` · ${channelModelNote}` : "";
  const modelLine = `🧠 Model: ${selectedModelLabel}${selectedAuthLabel}${modelNote}`;
  const showFallbackAuth = activeAuthLabelValue && activeAuthLabelValue !== selectedAuthLabelValue;
  const fallbackLine = fallbackState.active
    ? `↪️ Fallback: ${activeModelLabel}${
        showFallbackAuth ? ` · 🔑 ${activeAuthLabelValue}` : ""
      } (${fallbackState.reason ?? "selected model unavailable"})`
    : null;
  const commit = resolveCommitHash();
  const versionLine = `🦞 OpenClaw ${VERSION}${commit ? ` (${commit})` : ""}`;
  const usagePair = formatUsagePair(inputTokens, outputTokens);
  const cacheLine = formatCacheLine(inputTokens, cacheRead, cacheWrite);
  const costLine = costLabel ? `💵 Cost: ${costLabel}` : null;
  const usageCostLine =
    usagePair && costLine ? `${usagePair} · ${costLine}` : (usagePair ?? costLine);
  const mediaLine = formatMediaUnderstandingLine(args.mediaDecisions);
  const voiceLine = formatVoiceModeLine(args.config, args.sessionEntry);

  return [
    versionLine,
    args.timeLine,
    modelLine,
    fallbackLine,
    usageCostLine,
    cacheLine,
    `📚 ${contextLine}`,
    mediaLine,
    args.usageLine,
    `🧵 ${sessionLine}`,
    args.subagentsLine,
    `⚙️ ${optionsLine}`,
    voiceLine,
    activationLine,
  ]
    .filter(Boolean)
    .join("\n");
}

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

  const optionParts = ["/think <level>", "/model <id>", "/verbose on|off"];
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
  lines.push("  /status  |  /whoami  |  /context");
  lines.push("");

  lines.push("Skills");
  lines.push("  /skill <name> [input]");

  lines.push("");
  lines.push("More: /commands for full list");

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
