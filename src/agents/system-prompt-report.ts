/**
 * System prompt report builder.
 *
 * Session metadata uses this report to account for prompt size, bootstrap file
 * injection, skills, and tool schema footprint without storing raw prompt text.
 */
import { createHash } from "node:crypto";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import type { AgentTool } from "./runtime/index.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

type ToolReportEntry = SessionSystemPromptReport["tools"]["entries"][number];

const toolReportEntryCache = new WeakMap<AgentTool, ToolReportEntry>();
const toolSchemaStatsCache = new WeakMap<
  object,
  Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash">
>();

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const EMPTY_SCHEMA_STATS: Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash"> =
  {
    schemaChars: 0,
    schemaHash: sha256(""),
    propertiesCount: null,
  };

function extractBetween(input: string, startMarker: string, endMarker: string): string {
  const start = input.indexOf(startMarker);
  if (start === -1) {
    return "";
  }
  const end = input.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? input.slice(start) : input.slice(start, end);
}

function parseSkillBlocks(skillsPrompt: string): Array<{ name: string; blockChars: number }> {
  const prompt = skillsPrompt.trim();
  if (!prompt) {
    return [];
  }
  const blocks = Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map(
    (match) => match[0] ?? "",
  );
  return blocks
    .map((block) => {
      const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)";
      return { name, blockChars: block.length };
    })
    .filter((b) => b.blockChars > 0);
}

function readToolStringField(
  tool: AgentTool,
  field: "description" | "label" | "name",
): string | undefined {
  try {
    const value = (tool as unknown as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readToolParameters(tool: AgentTool): AgentTool["parameters"] | undefined {
  try {
    return tool.parameters;
  } catch {
    return undefined;
  }
}

function getCachedToolEntry(tool: AgentTool): ToolReportEntry | undefined {
  try {
    return toolReportEntryCache.get(tool);
  } catch {
    return undefined;
  }
}

function cacheToolEntry(tool: AgentTool, entry: ToolReportEntry): void {
  try {
    toolReportEntryCache.set(tool, entry);
  } catch {
    // Prompt reports are diagnostics; malformed tool descriptors should not block a turn.
  }
}

function getCachedSchemaStats(
  parameters: object,
): Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash"> | undefined {
  try {
    return toolSchemaStatsCache.get(parameters);
  } catch {
    return undefined;
  }
}

function cacheSchemaStats(
  parameters: object,
  stats: Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash">,
): void {
  try {
    toolSchemaStatsCache.set(parameters, stats);
  } catch {
    // Schema stat caching is an optimization only.
  }
}

function countSchemaProperties(parameters: object): number | null {
  let properties: unknown;
  try {
    properties = (parameters as Record<string, unknown>).properties;
  } catch {
    return null;
  }
  if (!properties || typeof properties !== "object") {
    return null;
  }
  try {
    return Object.keys(properties as Record<string, unknown>).length;
  } catch {
    return null;
  }
}

function buildToolSchemaStats(
  parameters: AgentTool["parameters"] | undefined,
): Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash"> {
  if (!parameters || typeof parameters !== "object") {
    return EMPTY_SCHEMA_STATS;
  }
  const cached = getCachedSchemaStats(parameters);
  if (cached) {
    return cached;
  }
  let schemaJson;
  try {
    schemaJson = JSON.stringify(parameters);
  } catch {
    schemaJson = "";
  }
  const stats = {
    schemaChars: schemaJson.length,
    schemaHash: sha256(schemaJson),
    propertiesCount: countSchemaProperties(parameters),
  };
  cacheSchemaStats(parameters, stats);
  return stats;
}

function buildToolsEntries(tools: AgentTool[]): SessionSystemPromptReport["tools"]["entries"] {
  return tools.map((tool) => {
    const cached = getCachedToolEntry(tool);
    if (cached) {
      return cached;
    }
    const name = readToolStringField(tool, "name") ?? "(unknown)";
    const summary =
      readToolStringField(tool, "description")?.trim() ||
      readToolStringField(tool, "label")?.trim() ||
      "";
    const summaryChars = summary.length;
    const schemaStats = buildToolSchemaStats(readToolParameters(tool));
    const entry = { name, summaryChars, summaryHash: sha256(summary), ...schemaStats };
    cacheToolEntry(tool, entry);
    return entry;
  });
}

function measureRenderedProjectContextChars(systemPrompt: string): number {
  return extractBetween(systemPrompt, "\n# Project Context\n", "\n## Silent Replies\n").length;
}

/** Builds the stored report for a rendered system prompt and its inputs. */
export function buildSystemPromptReport(params: {
  source: SessionSystemPromptReport["source"];
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: SessionSystemPromptReport["bootstrapTruncation"];
  sandbox?: SessionSystemPromptReport["sandbox"];
  systemPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  skillsPrompt: string;
  tools: AgentTool[];
  currentTurn?: SessionSystemPromptReport["currentTurn"];
}): SessionSystemPromptReport {
  const systemPromptChars = params.systemPrompt.length;
  const projectContextChars = measureRenderedProjectContextChars(params.systemPrompt);
  const toolsEntries = buildToolsEntries(params.tools);
  const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
  const skillsEntries = parseSkillBlocks(params.skillsPrompt);

  return {
    source: params.source,
    generatedAt: params.generatedAt,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    bootstrapMaxChars: params.bootstrapMaxChars,
    bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
    ...(params.bootstrapTruncation ? { bootstrapTruncation: params.bootstrapTruncation } : {}),
    sandbox: params.sandbox,
    systemPrompt: {
      chars: systemPromptChars,
      hash: sha256(params.systemPrompt),
      projectContextChars,
      nonProjectContextChars: Math.max(0, systemPromptChars - projectContextChars),
    },
    ...(params.currentTurn ? { currentTurn: params.currentTurn } : {}),
    injectedWorkspaceFiles: buildBootstrapInjectionStats({
      bootstrapFiles: params.bootstrapFiles,
      injectedFiles: params.injectedFiles,
    }),
    skills: {
      promptChars: params.skillsPrompt.length,
      hash: sha256(params.skillsPrompt),
      entries: skillsEntries,
    },
    tools: {
      listChars: 0,
      schemaChars: toolsSchemaChars,
      entries: toolsEntries,
    },
  };
}
