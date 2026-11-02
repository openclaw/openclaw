/**
 * System prompt report builder.
 *
 * Session metadata uses this report to account for prompt size, bootstrap file
 * injection, skills, and tool schema footprint without storing raw prompt text.
 */
import {
  splitSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "@openclaw/ai/internal/shared";
import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { classifyAgentToolSource } from "../plugins/tool-metadata.js";
import { indexFirstByKey } from "../shared/dedupe-by-key.js";
import type { BootstrapInjectionStat } from "./bootstrap-budget.types.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";
type PromptReportTool = { name: string; parameters: unknown; description?: string; label?: string };

type ToolReportEntry = SessionSystemPromptReport["tools"]["entries"][number];

// Finalization rebuilds tool objects, while Code Mode updates retained descriptions.
// Cache only the summary digest, with bounded key size and entry count.
const toolSummaryHashCache = new Map<string, string>();
const MAX_TOOL_SUMMARY_HASHES = 512;
const MAX_CACHED_TOOL_SUMMARY_CHARS = 4_096;
const toolSchemaStatsCache = new WeakMap<
  object,
  Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash">
>();

function parseSkillBlocks(skillsPrompt: string): Array<{ name: string; blockChars: number }> {
  return Array.from(skillsPrompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi), (match) => {
    const block = match[0];
    const nameStart = block.search(/<name>\s*[^<]+?\s*<\/name>/i);
    const name =
      nameStart < 0
        ? "(unknown)"
        : block.slice(nameStart + 6, block.indexOf("<", nameStart + 6)).trim() || "(unknown)";
    // Flatten a name-sized string before slicing so captures cannot retain the whole catalog.
    return { name: ` ${name}`.slice(1), blockChars: block.length };
  });
}

function buildToolSchemaStats(
  parameters: unknown,
): Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash"> {
  if (!parameters || typeof parameters !== "object") {
    return { schemaChars: 0, schemaHash: sha256Hex(""), propertiesCount: null };
  }
  const cached = toolSchemaStatsCache.get(parameters);
  if (cached) {
    return cached;
  }
  let schemaJson;
  try {
    schemaJson = JSON.stringify(parameters);
  } catch {
    schemaJson = "";
  }
  const properties = (parameters as Record<string, unknown>).properties;
  const stats = {
    schemaChars: schemaJson.length,
    schemaHash: sha256Hex(schemaJson),
    propertiesCount:
      properties && typeof properties === "object" ? Object.keys(properties).length : null,
  };
  // Tool parameter objects are reused across runs; cache their stable size/hash
  // so report generation stays cheap during frequent prompt rebuilds.
  toolSchemaStatsCache.set(parameters, stats);
  return stats;
}

function resolveSummaryHash(summary: string): string {
  if (summary.length > MAX_CACHED_TOOL_SUMMARY_CHARS) {
    return sha256Hex(summary);
  }
  const cached = toolSummaryHashCache.get(summary);
  if (cached !== undefined) {
    return cached;
  }
  const hash = sha256Hex(summary);
  toolSummaryHashCache.set(summary, hash);
  pruneMapToMaxSize(toolSummaryHashCache, MAX_TOOL_SUMMARY_HASHES);
  return hash;
}

function buildToolsEntries(
  tools: PromptReportTool[],
  catalogEntries?: readonly ToolSearchCatalogEntry[],
): SessionSystemPromptReport["tools"]["entries"] {
  const visibleEntries = catalogEntries
    ? indexFirstByKey(
        catalogEntries.filter((entry) => entry.directVisible),
        (entry) => entry.name,
      )
    : undefined;
  return tools.map((tool) => {
    const name = tool.name;
    const summary = tool.description?.trim() || tool.label?.trim() || "";
    const summaryChars = summary.length;
    const schemaStats = buildToolSchemaStats(tool.parameters);
    const catalogEntry = visibleEntries?.get(name);
    const provenance = catalogEntry ?? classifyAgentToolSource(tool);
    return {
      name,
      summaryChars,
      summaryHash: resolveSummaryHash(summary),
      ...schemaStats,
      source: provenance.source,
      sourceName: provenance.sourceName,
      serverName: provenance.mcp?.serverName,
    };
  });
}

function buildDeferredToolsReport(
  catalogEntries: readonly ToolSearchCatalogEntry[],
): NonNullable<SessionSystemPromptReport["tools"]["deferred"]> {
  const entries = catalogEntries
    .filter((entry) => !entry.directVisible)
    .map((entry) => {
      // Remote/client schemas may be lazy hostile objects. Only their owner's
      // detached JSON publication can supply a size without traversing them.
      const published = getPublishedRuntimeToolInputSchema(entry.parameters);
      const schemaChars =
        published?.json.length ??
        (entry.source === "openclaw" ? buildToolSchemaStats(entry.parameters).schemaChars : null);
      return {
        name: entry.name,
        source: entry.source,
        sourceName: entry.sourceName,
        serverName: entry.mcp?.serverName,
        schemaChars,
      };
    });
  return {
    entries,
    schemaChars: entries.reduce((sum, entry) => sum + (entry.schemaChars ?? 0), 0),
  };
}

function measureRenderedProjectContextChars(systemPrompt: string): number {
  // Project Context ends before the run-scoped capability and catalog instructions.
  const startMarker = "\n# Project Context\n";
  const start = systemPrompt.indexOf(startMarker);
  if (start === -1) {
    return 0;
  }
  const end = systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY, start + startMarker.length);
  return (end === -1 ? systemPrompt.length : end) - start;
}

function resolveRenderedSkillsPrompt(systemPrompt: string, skillsPrompt: string): string {
  const catalog = skillsPrompt.trim();
  if (!catalog) {
    return "";
  }
  // The renderer places the catalog after this boundary. Workspace examples and
  // provider headings in the stable prefix are not the rendered Skills section.
  const prompt = splitSystemPromptCacheBoundary(systemPrompt)?.dynamicSuffix ?? systemPrompt;
  for (const heading of prompt.matchAll(/(?:^|\n)## Skills\n/g)) {
    const sectionStart = heading.index + heading[0].length;
    const catalogStart = prompt.indexOf(catalog, sectionStart);
    const nextSection = prompt.indexOf("\n#", sectionStart);
    // Match the whole known catalog, allowing headings inside its descriptions,
    // only when it starts in the rendered Skills section.
    if (catalogStart >= 0 && (nextSection < 0 || catalogStart < nextSection)) {
      return catalog;
    }
  }
  return "";
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
  injectedWorkspaceFiles: BootstrapInjectionStat[];
  skillsPrompt: string;
  tools: PromptReportTool[];
  catalogEntries?: readonly ToolSearchCatalogEntry[];
  currentTurn?: SessionSystemPromptReport["currentTurn"];
}): SessionSystemPromptReport {
  const systemPromptChars = params.systemPrompt.length;
  const projectContextChars = measureRenderedProjectContextChars(params.systemPrompt);
  const toolsEntries = buildToolsEntries(params.tools, params.catalogEntries);
  const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
  const skillsPrompt = resolveRenderedSkillsPrompt(params.systemPrompt, params.skillsPrompt);
  const skillsEntries = parseSkillBlocks(skillsPrompt);

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
      hash: sha256Hex(params.systemPrompt),
      projectContextChars,
      nonProjectContextChars: Math.max(0, systemPromptChars - projectContextChars),
    },
    ...(params.currentTurn ? { currentTurn: params.currentTurn } : {}),
    injectedWorkspaceFiles: params.injectedWorkspaceFiles,
    skills: {
      promptChars: skillsPrompt.length,
      hash: sha256Hex(skillsPrompt),
      entries: skillsEntries,
    },
    tools: {
      listChars: 0,
      schemaChars: toolsSchemaChars,
      entries: toolsEntries,
      ...(params.catalogEntries
        ? { deferred: buildDeferredToolsReport(params.catalogEntries) }
        : {}),
    },
  };
}
