import type { OpenClawConfig } from "../config/config.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { resolveAgentDir, resolveAgentWorkspaceDir, resolveSessionAgentId } from "./agent-scope.js";
import { getChannelAgentToolMeta } from "./channel-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { resolveToolDisplay } from "./tool-display.js";
import type { AnyAgentTool } from "./tools/common.js";

export type EffectiveToolSource = "core" | "plugin" | "channel";

export type EffectiveToolInventoryEntry = {
  id: string;
  label: string;
  description: string;
  rawDescription: string;
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
};

export type EffectiveToolInventoryGroup = {
  id: EffectiveToolSource;
  label: string;
  source: EffectiveToolSource;
  tools: EffectiveToolInventoryEntry[];
};

export type EffectiveToolInventoryResult = {
  agentId: string;
  groups: EffectiveToolInventoryGroup[];
};

export type ResolveEffectiveToolInventoryParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  agentDir?: string;
  messageProvider?: string;
  senderIsOwner?: boolean;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  accountId?: string | null;
  modelProvider?: string;
  modelId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all";
  modelHasVision?: boolean;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
};

function resolveEffectiveToolLabel(tool: AnyAgentTool): string {
  const rawLabel = typeof tool.label === "string" ? tool.label.trim() : "";
  if (rawLabel && rawLabel.toLowerCase() !== tool.name.toLowerCase()) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: tool.name }).title;
}

function resolveRawToolDescription(tool: AnyAgentTool): string {
  return typeof tool.description === "string" ? tool.description.trim() : "";
}

function normalizeSummaryWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateSummary(value: string, maxLen = 120): string {
  if (value.length <= maxLen) {
    return value;
  }
  const sliced = value.slice(0, maxLen - 3);
  const boundary = sliced.lastIndexOf(" ");
  const trimmed = (boundary >= 48 ? sliced.slice(0, boundary) : sliced).trimEnd();
  return `${trimmed}...`;
}

function isDocBlockStart(line: string): boolean {
  const normalized = line.trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized === "ACTIONS:" ||
    normalized === "JOB SCHEMA (FOR ADD ACTION):" ||
    normalized === "JOB SCHEMA:" ||
    normalized === "SESSION TARGET OPTIONS:" ||
    normalized === "DEFAULT BEHAVIOR (UNCHANGED FOR BACKWARD COMPATIBILITY):" ||
    normalized === "SCHEDULE TYPES (SCHEDULE.KIND):" ||
    normalized === "PAYLOAD TYPES (PAYLOAD.KIND):" ||
    normalized === "DELIVERY (TOP-LEVEL):" ||
    normalized === "CRITICAL CONSTRAINTS:" ||
    normalized === "WAKE MODES (FOR WAKE ACTION):"
  ) {
    return true;
  }
  if (
    normalized.endsWith(":") &&
    normalized === normalized.toUpperCase() &&
    normalized.length > 12
  ) {
    return true;
  }
  return false;
}

function summarizeToolDescription(tool: AnyAgentTool): string {
  const explicit = typeof tool.displaySummary === "string" ? tool.displaySummary.trim() : "";
  if (explicit) {
    return truncateSummary(normalizeSummaryWhitespace(explicit));
  }

  const raw = resolveRawToolDescription(tool);
  if (!raw) {
    return "Tool";
  }

  const paragraphs = raw
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      continue;
    }
    const first = lines[0] ?? "";
    if (!first || isDocBlockStart(first)) {
      continue;
    }
    if (first.startsWith("{") || first.startsWith("[") || first.startsWith("- ")) {
      continue;
    }
    return truncateSummary(normalizeSummaryWhitespace(first));
  }

  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !isDocBlockStart(line) &&
        !line.startsWith("{") &&
        !line.startsWith("[") &&
        !line.startsWith("- "),
    );
  return firstLine ? truncateSummary(normalizeSummaryWhitespace(firstLine)) : "Tool";
}

function resolveEffectiveToolSource(tool: AnyAgentTool): {
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
} {
  const pluginMeta = getPluginToolMeta(tool);
  if (pluginMeta) {
    return { source: "plugin", pluginId: pluginMeta.pluginId };
  }
  const channelMeta = getChannelAgentToolMeta(tool as never);
  if (channelMeta) {
    return { source: "channel", channelId: channelMeta.channelId };
  }
  return { source: "core" };
}

function groupLabel(source: EffectiveToolSource): string {
  switch (source) {
    case "plugin":
      return "Connected tools";
    case "channel":
      return "Channel tools";
    default:
      return "Built-in tools";
  }
}

function disambiguateLabels(entries: EffectiveToolInventoryEntry[]): EffectiveToolInventoryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if ((counts.get(entry.label) ?? 0) < 2) {
      return entry;
    }
    const suffix = entry.pluginId ?? entry.channelId ?? entry.id;
    return { ...entry, label: `${entry.label} (${suffix})` };
  });
}

export function resolveEffectiveToolInventory(
  params: ResolveEffectiveToolInventoryParams,
): EffectiveToolInventoryResult {
  const agentId =
    params.agentId?.trim() ||
    resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, agentId);

  const effectiveTools = createOpenClawCodingTools({
    agentId,
    sessionKey: params.sessionKey,
    workspaceDir,
    agentDir,
    config: params.cfg,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    messageProvider: params.messageProvider,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId,
    senderName: params.senderName ?? undefined,
    senderUsername: params.senderUsername ?? undefined,
    senderE164: params.senderE164 ?? undefined,
    agentAccountId: params.accountId ?? undefined,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    groupId: params.groupId ?? undefined,
    groupChannel: params.groupChannel ?? undefined,
    groupSpace: params.groupSpace ?? undefined,
    replyToMode: params.replyToMode,
    modelHasVision: params.modelHasVision,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    disableMessageTool: params.disableMessageTool,
  });

  const entries = disambiguateLabels(
    effectiveTools
      .map((tool) => {
        const source = resolveEffectiveToolSource(tool);
        return {
          id: tool.name,
          label: resolveEffectiveToolLabel(tool),
          description: summarizeToolDescription(tool),
          rawDescription: resolveRawToolDescription(tool) || summarizeToolDescription(tool),
          ...source,
        } satisfies EffectiveToolInventoryEntry;
      })
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );

  const groupsBySource = new Map<EffectiveToolSource, EffectiveToolInventoryEntry[]>();
  for (const entry of entries) {
    const tools = groupsBySource.get(entry.source) ?? [];
    tools.push(entry);
    groupsBySource.set(entry.source, tools);
  }

  const groups = (["core", "plugin", "channel"] as const)
    .map((source) => {
      const tools = groupsBySource.get(source);
      if (!tools || tools.length === 0) {
        return null;
      }
      return {
        id: source,
        label: groupLabel(source),
        source,
        tools,
      } satisfies EffectiveToolInventoryGroup;
    })
    .filter((group): group is EffectiveToolInventoryGroup => group !== null);

  return { agentId, groups };
}
