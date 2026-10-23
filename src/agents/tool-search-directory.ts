import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isLocalModelLeanEnabled } from "./local-model-lean.js";
import {
  applyToolCatalogCompaction,
  collectUniqueCatalogToolNames,
  isDirectVisibleCatalogTool,
  resolveCatalog,
  toolSchemaDirectoryPromptCache,
  visibleCatalogEntries,
} from "./tool-search-catalog.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import {
  TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type CatalogVisibilityOptions,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
  type ToolSearchMode,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import type { AnyAgentTool } from "./tools/common.js";

const MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS = 18_000;
const TOOL_DIRECTORY_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export function applyToolSchemaDirectoryCatalog(params: {
  tools: AnyAgentTool[];
  config?: Parameters<typeof resolveToolSearchConfig>[0];
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: Parameters<typeof applyToolCatalogCompaction>[0]["toolHookContext"];
  directToolNames?: Iterable<string>;
}) {
  const config = resolveToolSearchConfig(params.config);
  if (!config.enabled || !params.tools.some((tool) => tool.name === TOOL_SEARCH_RAW_TOOL_NAME)) {
    return applyToolCatalogCompaction({
      ...params,
      enabled: config.enabled,
      isVisibleControlTool: () => false,
    });
  }
  const directToolNames = new Set(normalizeStringEntries(Array.from(params.directToolNames ?? [])));
  const uniqueCatalogToolNames = collectUniqueCatalogToolNames(params.tools);
  return applyToolCatalogCompaction({
    ...params,
    enabled: config.enabled,
    selection: config,
    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    // The unique-name gate defers any cross-source name collision before the
    // shared trust check runs.
    isVisibleCatalogTool: (tool) =>
      uniqueCatalogToolNames.has(tool.name) && isDirectVisibleCatalogTool(tool, directToolNames),
  });
}

export function buildToolSchemaDirectoryPrompt(
  ctx: ToolSearchToolContext,
  options?: CatalogVisibilityOptions & {
    contextTokenBudget?: number;
    toolSearchDirectoryLean?: boolean;
  },
): string {
  const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
  const catalog = resolveCatalog(ctx);
  const contextTokens = options?.contextTokenBudget;
  // At four characters per token, the listing gets 2.5% of the active window.
  // Keep enough room for discovery instructions even in a very small window.
  const maxChars =
    contextTokens && Number.isFinite(contextTokens) && contextTokens > 0
      ? Math.min(
          MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS,
          Math.max(768, Math.floor(contextTokens / 10)),
        )
      : MAX_TOOL_SCHEMA_DIRECTORY_PROMPT_CHARS;
  // Lean filtering must not buy longer descriptions for the remaining tools.
  const descriptionMaxChars =
    (options?.toolSearchDirectoryLean ?? isLocalModelLeanEnabled(ctx)) ? 0 : 180;
  const cacheKey = `${config.mode}:${options?.includeMcp === false ? "without-mcp" : "all"}:${maxChars}:${descriptionMaxChars}`;
  let cachedPrompts = toolSchemaDirectoryPromptCache.get(catalog.entries);
  // Caller-owned filters may change in place; cached text must not bypass them.
  const cachedPrompt = options?.allowedIds ? undefined : cachedPrompts?.get(cacheKey);
  if (cachedPrompt !== undefined) {
    return cachedPrompt;
  }
  const prompt = formatToolSearchCatalogDirectory(
    visibleCatalogEntries(catalog, options),
    config.mode,
    maxChars,
    descriptionMaxChars,
  );
  if (options?.allowedIds) {
    return prompt;
  }
  if (!cachedPrompts) {
    cachedPrompts = new Map<string, string>();
    toolSchemaDirectoryPromptCache.set(catalog.entries, cachedPrompts);
  }
  cachedPrompts.set(cacheKey, prompt);
  pruneMapToMaxSize(cachedPrompts, 12);
  return prompt;
}

export function resolveToolSearchCatalogTool(
  ctx: ToolSearchToolContext,
  name: unknown,
  options?: CatalogVisibilityOptions,
): AnyAgentTool | undefined {
  const catalog = ctx.catalogRef?.current;
  const needle = typeof name === "string" ? name.trim() : "";
  if (!needle || !catalog) {
    return undefined;
  }
  const matches = visibleCatalogEntries(catalog, options).filter((entry) => entry.name === needle);
  return matches.length === 1 && !matches[0]?.requiresExactId
    ? (matches[0]?.tool as AnyAgentTool | undefined)
    : undefined;
}

function compactDirectoryDescription(description: string, maxChars: number): string {
  // Collapsing whitespace only shrinks text, so a normalized raw window longer than the
  // limit already proves truncation without normalizing the whole description.
  const window = description.slice(0, maxChars * 4);
  let normalized = window.replace(/\s+/g, " ").trimStart();
  if (window.length === description.length) {
    normalized = normalized.trimEnd();
  } else if (normalized.length <= maxChars + 1) {
    normalized = description.replace(/\s+/g, " ").trim();
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, maxChars - 3).trimEnd()}...`;
}

function formatToolDirectoryIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && TOOL_DIRECTORY_IDENTIFIER_RE.test(trimmed) ? trimmed : undefined;
}

type ToolDirectoryRow = { label: string; description: string };

function prepareToolDirectoryRow(entry: ToolSearchCatalogEntry): ToolDirectoryRow | undefined {
  if (entry.source !== "openclaw") {
    return undefined;
  }
  const name = formatToolDirectoryIdentifier(entry.name);
  if (!name) {
    return undefined;
  }
  const ownerName = formatToolDirectoryIdentifier(entry.sourceName);
  return {
    label: `- ${name}${ownerName ? ` (${ownerName})` : ""}`,
    description: entry.description,
  };
}

function formatToolDirectoryRow(row: ToolDirectoryRow, descriptionMaxChars: number): string {
  if (descriptionMaxChars === 0) {
    return row.label;
  }
  const description = compactDirectoryDescription(row.description, descriptionMaxChars);
  return `${row.label}: ${description || "No description."}`;
}

function formatToolSearchCatalogDirectory(
  entries: ToolSearchCatalogEntry[],
  mode: ToolSearchMode,
  maxChars: number,
  initialDescriptionMaxChars: number,
): string {
  const deferredEntries = entries.filter((entry) => !entry.directVisible);
  if (deferredEntries.length === 0) {
    return "Available deferred-schema tools: none.";
  }
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  // Count collisions before excluding native tools: their lookalikes remain ambiguous.
  const listedEntries = deferredEntries
    .filter((entry) => !entry.requiresExactId && nameCounts.get(entry.name) === 1)
    .toSorted(
      (left, right) =>
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  const rows = listedEntries
    .map(prepareToolDirectoryRow)
    .filter((row): row is ToolDirectoryRow => row !== undefined);
  let descriptionMaxChars = initialDescriptionMaxChars;
  const renderRows = () => rows.map((row) => formatToolDirectoryRow(row, descriptionMaxChars));
  let lines = renderRows();
  const heading = "Available deferred-schema tools:";
  const notice = "Policy-approved MCP and client tools may also be discoverable through search.";
  const omittedLabel = " additional tools omitted. ";
  // Each line includes its newline; three fixed separators remain outside the rows.
  let lineChars = lines.reduce((chars, line) => chars + line.length + 1, 0);
  let omitted = deferredEntries.length - lines.length;
  let guidance: string;
  for (;;) {
    guidance =
      omitted > 0
        ? "Use tool_search to find a tool and its input signature; use tool_describe when a full schema is needed."
        : "Use tool_search for a compact input signature or tool_describe for a full schema.";
    if (mode === "tools") {
      guidance +=
        " Deferred names are not directly callable. Call dispatch_action with the result id or name in id and all tool parameters in args. Use this wrapper even when other guidance names a deferred tool directly.";
    } else if (mode === "directory") {
      guidance +=
        " Call a unique deferred tool name directly, or use dispatch_action with its id and args.";
    }
    const footerChars =
      guidance.length + (omitted > 0 ? String(omitted).length + omittedLabel.length : 0);
    if (
      heading.length + lineChars + notice.length + footerChars + 3 <= maxChars ||
      lines.length === 0
    ) {
      break;
    }
    // Preserve capability names before dropping rows; full descriptions remain searchable.
    if (descriptionMaxChars > 0) {
      descriptionMaxChars = descriptionMaxChars === 180 ? 64 : 0;
      lines = renderRows();
      lineChars = lines.reduce((chars, line) => chars + line.length + 1, 0);
      continue;
    }
    // SAFETY: this renderer owns the nonempty, dense formatted-line array.
    // Remove excluded rows before materializing the bounded directory.
    lineChars -= lines.pop()!.length + 1;
    omitted += 1;
  }
  const footer = omitted > 0 ? `${omitted}${omittedLabel}${guidance}` : guidance;
  return [heading, ...lines, "", notice, footer].join("\n");
}
