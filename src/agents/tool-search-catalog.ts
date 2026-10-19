import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { stableStringify } from "@openclaw/normalization-core";
import { generateSecureHex } from "../infra/secure-random.js";
import { classifyAgentToolSource } from "../plugins/tool-metadata.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { getBeforeToolCallDiagnosticOptions } from "./before-tool-call-metadata.js";
import { disposeCodeModeResults } from "./code-mode-results.js";
import type { ToolDefinition } from "./sessions/index.js";
import { isCoreCodingSurfaceToolName } from "./tool-catalog.js";
import { compactToolInputHint, compactToolOutputHint } from "./tool-schema-hints.js";
import { disposeToolSearchSchedule } from "./tool-search-scheduling.js";
import {
  TOOL_SEARCH_CONTROL_TOOL_NAMES,
  type CatalogSource,
  type CatalogTool,
  type CatalogVisibilityOptions,
  type ToolSearchCatalogApplyResult,
  type ToolSearchCatalogCompactionParams,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogSession,
  type ToolSearchCatalogTelemetry,
  type ToolSearchToolContext,
} from "./tool-search-types.js";
import { ToolInputError, type AnyAgentTool } from "./tools/common.js";

// Catalog entry arrays are immutable snapshots. Keying rendered directories by array identity
// preserves prompt-prefix bytes without retaining retired catalogs.
export const toolSchemaDirectoryPromptCache = new WeakMap<
  ToolSearchCatalogEntry[],
  Map<string, string>
>();
const catalogMetadata = new WeakMap<
  ToolSearchCatalogSession,
  { toolExecutionAllow?: readonly string[] }
>();

// Registered entries are immutable snapshots, so reuse compares live descriptors. Registration
// keeps entries id-sorted and unique, so equal catalogs match position by position.
function sameCatalogDescriptors(
  previous: readonly ToolSearchCatalogEntry[],
  next: readonly ToolSearchCatalogEntry[],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((entry, index) => sameCatalogDescriptor(entry, next[index]!))
  );
}

function sameCatalogDescriptor(a: ToolSearchCatalogEntry, b: ToolSearchCatalogEntry): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.source === b.source &&
      (a.sourceName ?? "") === (b.sourceName ?? "") &&
      a.name === b.name &&
      (a.label ?? "") === (b.label ?? "") &&
      a.description === b.description &&
      (a.directVisible === true) === (b.directVisible === true) &&
      (a.mcp === b.mcp || stableStringify(a.mcp) === stableStringify(b.mcp)) &&
      sameCatalogSchema(a.source, a.parameters, b.parameters) &&
      sameCatalogSchema(a.source, a.outputSchema, b.outputSchema))
  );
}

function sameCatalogSchema(source: CatalogSource, a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  // Remote/client schemas may be attacker-sized or lazy hostile objects; only identity
  // proves reuse, so a replaced schema never gets traversed.
  if (source !== "openclaw") {
    return false;
  }
  const publishedA = getPublishedRuntimeToolInputSchema(a)?.fingerprint;
  const publishedB = getPublishedRuntimeToolInputSchema(b)?.fingerprint;
  return publishedA !== undefined || publishedB !== undefined
    ? publishedA === publishedB
    : stableStringify(a) === stableStringify(b);
}

function rebindCatalogExecutors(
  existingEntries: ToolSearchCatalogEntry[],
  currentEntries: readonly ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] | undefined {
  const currentTools = new Map(currentEntries.map((entry) => [entry.id, entry.tool]));
  if (currentTools.size !== currentEntries.length || currentTools.size !== existingEntries.length) {
    return undefined;
  }
  // Keep identical same-run entries; changed executors need a detached descriptor snapshot.
  // Every exact ID must still resolve, so missing entries fail the reuse check below.
  const rebound = existingEntries.every(
    (entry) => entry.tool && currentTools.get(entry.id) === entry.tool,
  )
    ? existingEntries
    : existingEntries.map((entry) => {
        const tool = currentTools.get(entry.id);
        return tool ? { ...entry, tool } : undefined;
      });
  return rebound.every((entry): entry is ToolSearchCatalogEntry => entry !== undefined)
    ? rebound
    : undefined;
}

export function prepareToolSearchCatalogExecutionTool(
  entry: ToolSearchCatalogEntry,
  options: { prepareInput?: boolean; validateInput?: boolean },
): CatalogTool {
  const prepareInput =
    options.prepareInput &&
    entry.source === "openclaw" &&
    "prepareBeforeToolCallParams" in entry.tool &&
    typeof entry.tool.prepareBeforeToolCallParams === "function";
  const validateInput = options.validateInput && entry.source === "openclaw";
  if (!prepareInput && !validateInput) {
    return entry.tool;
  }
  // SAFETY: both gates above restrict wrapper execution to OpenClaw-owned catalog tools.
  const tool = entry.tool as AnyAgentTool;
  const wrapperOptions = options.prepareInput ? { protectNetworkErrors: false } : undefined;
  if (!isToolWrappedWithBeforeToolCallHook(tool)) {
    return wrapToolWithBeforeToolCallHook(tool, undefined, wrapperOptions);
  }
  if (!wrapperOptions || getBeforeToolCallDiagnosticOptions(tool)?.protectNetworkErrors === false) {
    return entry.tool;
  }
  return rewrapToolWithBeforeToolCallHook(tool, undefined, wrapperOptions);
}

function toCatalogEntry(
  tool: CatalogTool,
  sourceOverride?: CatalogSource,
  hookContext?: HookContext,
): ToolSearchCatalogEntry {
  const classified = classifyAgentToolSource(tool);
  const source = sourceOverride ?? classified.source;
  const sourceName = sourceOverride === "client" ? "client" : classified.sourceName;
  // SAFETY: source classification excludes client callbacks from the native hook wrapper.
  const nativeTool = tool as AnyAgentTool;
  const catalogTool =
    source !== "client" && hookContext && !isToolWrappedWithBeforeToolCallHook(nativeTool)
      ? wrapToolWithBeforeToolCallHook(nativeTool, hookContext)
      : tool;
  return {
    id: `${source}:${sourceName?.trim() || "core"}:${tool.name}`,
    source,
    sourceName,
    ...(source === "mcp" && classified.mcp ? { mcp: classified.mcp } : {}),
    name: tool.name,
    label: tool.label,
    description: tool.description ?? "",
    parameters: tool.parameters,
    ...(source === "openclaw" && (tool as AnyAgentTool).outputSchema
      ? { outputSchema: (tool as AnyAgentTool).outputSchema }
      : {}),
    tool: catalogTool,
  };
}

function shouldCatalogTool(tool: AnyAgentTool): boolean {
  return !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name) && tool.catalogMode !== "direct-only";
}

/**
 * Core file/shell primitives and caller-required names (e.g. message when it is
 * the only reply path) stay visible while remaining searchable. Both must
 * resolve to trusted OpenClaw tools: an MCP lookalike must never become a
 * direct delivery or core-coding tool.
 */
export function isDirectVisibleCatalogTool(
  tool: AnyAgentTool,
  directToolNames: ReadonlySet<string>,
): boolean {
  const classified = classifyAgentToolSource(tool);
  return (
    classified.source === "openclaw" &&
    (directToolNames.has(tool.name) ||
      (isCoreCodingSurfaceToolName(tool.name) && classified.sourceName === "core"))
  );
}

export function registerHeadlessToolSearchCatalog(params: {
  catalogRef: ToolSearchCatalogRef;
  tools: readonly AnyAgentTool[];
  hookContext?: HookContext;
}): void {
  const { catalogRef, tools, hookContext } = params;
  const entries = tools.filter(shouldCatalogTool).map((tool) => {
    const scopedTool =
      hookContext && isToolWrappedWithBeforeToolCallHook(tool)
        ? rewrapToolWithBeforeToolCallHook(tool, hookContext)
        : tool;
    return toCatalogEntry(scopedTool, undefined, hookContext);
  });
  registerToolSearchCatalog({ catalogRef, entries });
}

export function collectUniqueCatalogToolNames(tools: readonly AnyAgentTool[]): Set<string> {
  const nameCounts = new Map<string, number>();
  for (const tool of tools) {
    if (shouldCatalogTool(tool)) {
      nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
    }
  }
  return new Set(
    Array.from(nameCounts)
      .filter(([, count]) => count === 1)
      .map(([name]) => name),
  );
}

function finalizeCatalogAvailability(
  entries: ToolSearchCatalogEntry[],
  toolExecutionAllow?: readonly string[],
): ToolSearchCatalogEntry[] {
  const orderedEntries = entries.toSorted((a, b) => a.id.localeCompare(b.id));
  // Client definitions win exact-name shadows, matching the guest projection.
  const tools = orderedEntries
    .toSorted((a, b) => Number(a.source === "client") - Number(b.source === "client"))
    .map((entry) => entry.tool);
  finalizeAgentToolAvailability(tools, { toolExecutionAllow });
  // The array is a fresh copy, but its descriptors may belong to retained snapshots.
  orderedEntries.forEach((entry, index) => {
    if (
      entry.parameters !== entry.tool.parameters ||
      entry.description !== entry.tool.description
    ) {
      orderedEntries[index] = {
        ...entry,
        parameters: entry.tool.parameters,
        description: entry.tool.description ?? "",
      };
    }
  });
  return orderedEntries;
}

function registerToolSearchCatalog(params: {
  catalogRef: ToolSearchCatalogRef;
  entries: ToolSearchCatalogEntry[];
  mode?: "append" | "reuse";
  toolExecutionAllow?: readonly string[];
}): boolean {
  const existing = params.catalogRef.current;
  const prior = params.mode === "append" ? existing : undefined;
  // Appending client definitions cannot widen the current run's execution policy.
  const toolExecutionAllow = prior
    ? catalogMetadata.get(prior)?.toolExecutionAllow
    : params.toolExecutionAllow;
  const byId = new Map((prior?.entries ?? []).map((entry) => [entry.id, entry]));
  for (const entry of params.entries) {
    byId.set(entry.id, entry);
  }
  // Callable bindings can change while descriptors stay equal; finalize before reuse.
  const entries = finalizeCatalogAvailability(Array.from(byId.values()), toolExecutionAllow);
  const metadata = existing && catalogMetadata.get(existing);
  const reboundEntries =
    params.mode === "reuse" &&
    existing &&
    metadata &&
    stableStringify(metadata.toolExecutionAllow) === stableStringify(toolExecutionAllow) &&
    sameCatalogDescriptors(existing.entries, entries)
      ? rebindCatalogExecutors(existing.entries, entries)
      : undefined;
  if (existing && reboundEntries) {
    const prompts = toolSchemaDirectoryPromptCache.get(existing.entries);
    if (prompts && reboundEntries !== existing.entries) {
      // Rebinding swaps executors only; rendered descriptors stay identical.
      toolSchemaDirectoryPromptCache.set(reboundEntries, prompts);
    }
    existing.entries = reboundEntries;
    return true;
  }
  const next = {
    entries,
    // Appended client tools extend the same counter lifetime. A replacement
    // gets a new scope so telemetry consumers never infer resets from values.
    // Hex avoids credential-shaped substrings that transcript redaction would alter.
    counterScope: prior?.counterScope ?? generateSecureHex(12),
    searchCount: prior?.searchCount ?? 0,
    describeCount: prior?.describeCount ?? 0,
    callCount: prior?.callCount ?? 0,
  };
  catalogMetadata.set(next, { toolExecutionAllow });
  params.catalogRef.current = next;
  if (!prior) {
    disposeCodeModeResults(params.catalogRef);
  }
  delete params.catalogRef.closedTelemetry;
  return false;
}

export function clearToolSearchCatalog(params: { catalogRef?: ToolSearchCatalogRef }): void {
  if (params.catalogRef) {
    // Capture only aggregate facts before releasing executable state. Disposal
    // can wake an in-flight wait that still needs its final diagnostics.
    if (params.catalogRef.current) {
      params.catalogRef.closedTelemetry = getTelemetry(params.catalogRef.current);
      finalizeAgentToolAvailability(
        params.catalogRef.current.entries.map((entry) => entry.tool),
        {
          toolExecutionAllow: [],
        },
      );
    }
    params.catalogRef.current = undefined;
    delete params.catalogRef.directOnlyToolNames;
    delete params.catalogRef.baselineDirectOnlyToolNames;
    disposeCodeModeResults(params.catalogRef);
    disposeToolSearchSchedule(params.catalogRef);
    params.catalogRef.onDispose?.forEach((dispose) => dispose());
    delete params.catalogRef.onDispose;
  }
}

/** Restricts a run-scoped catalog to an already-resolved set of concrete tool names. */
export function restrictToolSearchCatalog(params: {
  catalogRef?: ToolSearchCatalogRef;
  allowedToolNames: ReadonlySet<string>;
  baselineEntries?: readonly ToolSearchCatalogEntry[];
}): number {
  const owner = params.catalogRef;
  const current = owner?.current;
  if (!owner || !current) {
    return 0;
  }
  const metadata = catalogMetadata.get(current);
  const entries = finalizeCatalogAvailability(
    (params.baselineEntries ?? current.entries).filter((entry) =>
      params.allowedToolNames.has(entry.name),
    ),
    metadata?.toolExecutionAllow,
  );
  if (
    entries.length === current.entries.length &&
    entries.every((entry, index) => entry === current.entries[index])
  ) {
    return entries.length;
  }
  current.entries = entries;
  disposeCodeModeResults(owner);
  return entries.length;
}

export function resolveCatalog(ctx: ToolSearchToolContext): ToolSearchCatalogSession {
  const catalog = ctx.catalogRef?.current;
  if (!catalog) {
    throw new ToolInputError("Tool Search catalog is unavailable for this run.");
  }
  return catalog;
}

function getTelemetry(catalog: ToolSearchCatalogSession): ToolSearchCatalogTelemetry {
  const sources: Record<CatalogSource, number> = { openclaw: 0, mcp: 0, client: 0 };
  for (const entry of catalog.entries) {
    sources[entry.source] += 1;
  }
  return {
    catalogSize: catalog.entries.length,
    sources,
    counterScope: catalog.counterScope,
    searchCount: catalog.searchCount,
    describeCount: catalog.describeCount,
    callCount: catalog.callCount,
  };
}

export function readToolSearchCatalogTelemetry(
  ctx: ToolSearchToolContext,
): ToolSearchCatalogTelemetry {
  const closed = ctx.catalogRef?.closedTelemetry;
  if (!ctx.catalogRef?.current && closed) {
    return { ...closed, sources: { ...closed.sources } };
  }
  return getTelemetry(resolveCatalog(ctx));
}

export function visibleCatalogEntries(
  catalog: ToolSearchCatalogSession,
  options?: CatalogVisibilityOptions,
): ToolSearchCatalogEntry[] {
  const { includeMcp, allowedIds } = options ?? {};
  if (includeMcp !== false && !allowedIds) {
    return catalog.entries;
  }
  return catalog.entries.filter(
    (entry) =>
      (includeMcp !== false || entry.source !== "mcp") && (!allowedIds || allowedIds.has(entry.id)),
  );
}

export function compactToolSearchCatalogEntry(entry: ToolSearchCatalogEntry) {
  const output =
    entry.source === "openclaw" ? compactToolOutputHint(entry.outputSchema) : undefined;
  // Node provenance is namespace-only metadata; generic Tool Search keeps its
  // existing MCP result shape outside Code Mode.
  const mcp = entry.mcp
    ? {
        serverName: entry.mcp.serverName,
        safeServerName: entry.mcp.safeServerName,
        toolName: entry.mcp.toolName,
        operation: entry.mcp.operation,
      }
    : undefined;
  return {
    id: entry.id,
    source: entry.source,
    sourceName: entry.sourceName,
    ...(mcp ? { mcp } : {}),
    name: entry.name,
    label: entry.label,
    description: entry.description,
    input: entry.source === "openclaw" ? compactToolInputHint(entry.parameters) : "unknown",
    ...(output ? { output } : {}),
  };
}

export function createToolSearchCatalogRef(): ToolSearchCatalogRef {
  return {};
}

export function applyToolCatalogCompaction(
  params: ToolSearchCatalogCompactionParams,
): ToolSearchCatalogApplyResult {
  const hasControlTool =
    params.enabled && params.tools.some((tool) => params.isVisibleControlTool(tool));
  const catalogRef = params.catalogRef;
  if (!hasControlTool || !catalogRef) {
    return {
      tools: params.enabled
        ? params.tools.filter((tool) => !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name))
        : params.tools,
      compacted: false,
      catalogToolCount: 0,
      catalogRegistered: false,
      catalogReused: false,
    };
  }

  const visible: AnyAgentTool[] = [];
  const catalog: ToolSearchCatalogEntry[] = [];
  for (const tool of params.tools) {
    if (params.isVisibleControlTool(tool)) {
      visible.push(
        params.toolHookContext && !isToolWrappedWithBeforeToolCallHook(tool)
          ? wrapToolWithBeforeToolCallHook(tool, params.toolHookContext)
          : tool,
      );
      continue;
    }
    if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) {
      continue;
    }
    if (shouldCatalogTool(tool) && (params.shouldCatalogTool?.(tool) ?? true)) {
      const directVisible = params.isVisibleCatalogTool?.(tool) === true;
      catalog.push({ ...toCatalogEntry(tool, undefined, params.toolHookContext), directVisible });
      if (!directVisible) {
        continue;
      }
    }
    visible.push(tool);
  }
  const catalogReused = registerToolSearchCatalog({
    catalogRef,
    entries: catalog,
    mode: "reuse",
    toolExecutionAllow: params.toolExecutionAllow,
  });
  catalogRef.directOnlyToolNames = new Set(
    visible.filter((tool) => tool.catalogMode === "direct-only").map((tool) => tool.name),
  );
  catalogRef.baselineDirectOnlyToolNames = catalogRef.directOnlyToolNames;
  return {
    tools: visible,
    compacted: catalog.length > 0,
    catalogToolCount: catalog.length,
    catalogRegistered: true,
    catalogReused,
  };
}

export function addClientToolsToToolCatalog(params: {
  tools: ToolDefinition[];
  enabled: boolean;
  catalogRef?: ToolSearchCatalogRef;
}): { tools: ToolDefinition[]; compacted: boolean; catalogToolCount: number } {
  const catalogRef = params.catalogRef;
  if (!params.enabled || !catalogRef?.current || params.tools.length === 0) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  registerToolSearchCatalog({
    catalogRef,
    entries: params.tools.map((tool) => toCatalogEntry(tool, "client")),
    mode: "append",
  });
  return { tools: [], compacted: params.tools.length > 0, catalogToolCount: params.tools.length };
}
