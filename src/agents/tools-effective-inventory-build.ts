/**
 * Builds the operator-facing effective inventory for the current tool surface:
 * runtime-compatible tools plus warnings for tools quarantined by schema
 * policy, with plugin/channel ownership preserved.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  buildPluginToolMetadataKey,
  copyPluginToolMeta,
  getPluginToolMeta,
} from "../plugins/tools.js";
import { copyChannelAgentToolMeta, getChannelAgentToolMeta } from "./channel-tools.js";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";
import { buildEffectiveToolInventoryGroups } from "./tools-effective-inventory-groups.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryNotice,
  EffectiveToolSource,
} from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

type ToolInventoryDisplaySnapshot = {
  name: string;
  label: string;
  rawDescription: string;
  displaySummary?: string;
};

function readToolInventoryStringField(
  tool: AnyAgentTool,
  field: "description" | "displaySummary" | "label" | "name",
): string | undefined {
  try {
    return normalizeOptionalString((tool as unknown as Record<string, unknown>)[field]);
  } catch {
    return undefined;
  }
}

function readToolInventoryUnknownField(tool: AnyAgentTool, field: "parameters"): unknown {
  try {
    return (tool as unknown as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function snapshotToolInventoryDisplay(
  tool: AnyAgentTool,
): ToolInventoryDisplaySnapshot | undefined {
  const name = readToolInventoryStringField(tool, "name");
  if (!name) {
    return undefined;
  }
  const displaySummary = readToolInventoryStringField(tool, "displaySummary");
  return {
    name,
    label: readToolInventoryStringField(tool, "label") ?? "",
    rawDescription: readToolInventoryStringField(tool, "description") ?? "",
    ...(displaySummary ? { displaySummary } : {}),
  };
}

function copyInventoryToolMetadata(source: AnyAgentTool, target: AnyAgentTool): void {
  copyPluginToolMeta(source, target);
  copyChannelAgentToolMeta(source as never, target as never);
}

function snapshotToolForInventoryNormalization(tool: AnyAgentTool): AnyAgentTool | undefined {
  const snapshot = snapshotToolInventoryDisplay(tool);
  if (!snapshot) {
    return undefined;
  }
  const safeTool = {
    name: snapshot.name,
    label: snapshot.label,
    description: snapshot.rawDescription,
    parameters: readToolInventoryUnknownField(tool, "parameters"),
    execute: async () => ({ text: "" }),
    ...(snapshot.displaySummary ? { displaySummary: snapshot.displaySummary } : {}),
  } as unknown as AnyAgentTool;
  copyInventoryToolMetadata(tool, safeTool);
  return safeTool;
}

function resolveEffectiveToolLabel(snapshot: ToolInventoryDisplaySnapshot): string {
  const rawLabel = snapshot.label;
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(snapshot.name)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: snapshot.name }).title;
}

function summarizeToolDescription(snapshot: ToolInventoryDisplaySnapshot): string {
  return summarizeToolDescriptionText({
    rawDescription: snapshot.rawDescription,
    displaySummary: snapshot.displaySummary,
  });
}

// Tool metadata may be attached to the normalized tool or the raw fallback
// before schema projection. Check both so owner attribution survives cloning.
function resolveEffectiveToolSource(
  tool: AnyAgentTool,
  fallbackTool?: AnyAgentTool,
): {
  source: EffectiveToolSource;
  pluginId?: string;
  channelId?: string;
} {
  const pluginMeta =
    getPluginToolMeta(tool) ?? (fallbackTool ? getPluginToolMeta(fallbackTool) : undefined);
  if (pluginMeta) {
    if (pluginMeta.pluginId === "bundle-mcp") {
      return { source: "mcp", pluginId: pluginMeta.pluginId };
    }
    return { source: "plugin", pluginId: pluginMeta.pluginId };
  }
  const channelMeta =
    getChannelAgentToolMeta(tool as never) ??
    (fallbackTool ? getChannelAgentToolMeta(fallbackTool as never) : undefined);
  if (channelMeta) {
    return { source: "channel", channelId: channelMeta.channelId };
  }
  return { source: "core" };
}

// Unsupported-schema notices need owner context when available so operators know
// whether to disable a plugin/channel or fix core tool definitions.
function buildUnsupportedToolSchemaNotice(params: {
  diagnostic: RuntimeToolSchemaDiagnostic;
  tool: AnyAgentTool | undefined;
  fallbackTool: AnyAgentTool | undefined;
}): EffectiveToolInventoryNotice {
  const sourceTool = params.tool ?? params.fallbackTool;
  const source = sourceTool
    ? resolveEffectiveToolSource(sourceTool, params.fallbackTool)
    : { source: "core" as const };
  const owner =
    source.source === "plugin" && source.pluginId
      ? ` from plugin "${source.pluginId}"`
      : source.source === "channel" && source.channelId
        ? ` from channel "${source.channelId}"`
        : "";
  return {
    id: `unsupported-tool-schema:${params.diagnostic.toolName}`,
    severity: "warning",
    message: `Tool "${params.diagnostic.toolName}"${owner} has an unsupported runtime input schema (${params.diagnostic.violations.join(", ")}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
  };
}

function buildUnsupportedToolSchemaNotices(params: {
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
  tools: readonly AnyAgentTool[];
  rawToolsByName: ReadonlyMap<string, AnyAgentTool>;
}): EffectiveToolInventoryNotice[] {
  return params.diagnostics.map((diagnostic) =>
    buildUnsupportedToolSchemaNotice({
      diagnostic,
      tool: readMatchingTool(params.tools, diagnostic),
      fallbackTool: params.rawToolsByName.get(diagnostic.toolName),
    }),
  );
}

function readMatchingTool(
  tools: readonly AnyAgentTool[],
  diagnostic: RuntimeToolSchemaDiagnostic,
): AnyAgentTool | undefined {
  try {
    const tool = tools[diagnostic.toolIndex];
    return tool?.name === diagnostic.toolName ? tool : undefined;
  } catch {
    return undefined;
  }
}

// Raw tool arrays can contain getters/proxies from plugin boundaries. Read
// defensively; projection diagnostics handle the exact unreadable entry later.
function buildReadableRawToolsByName(
  tools: readonly AnyAgentTool[],
): ReadonlyMap<string, AnyAgentTool> {
  const toolsByName = new Map<string, AnyAgentTool>();
  let toolCount: number;
  try {
    toolCount = tools.length;
  } catch {
    return toolsByName;
  }
  for (let index = 0; index < toolCount; index += 1) {
    try {
      const tool = tools[index];
      const name = tool ? readToolInventoryStringField(tool, "name") : undefined;
      if (name) {
        toolsByName.set(name, tool);
      }
    } catch {
      // Unreadable entries are reported by the schema projection diagnostics.
    }
  }
  return toolsByName;
}

// Duplicate labels are ambiguous in inventory UIs; add the owner/id only where
// needed so unique entries keep their concise display names.
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

/** Builds effective inventory entries from already runtime-compatible tools. */
export function buildEffectiveToolInventoryEntries(
  tools: readonly AnyAgentTool[],
  rawToolsByName: ReadonlyMap<string, AnyAgentTool> = new Map(),
): EffectiveToolInventoryEntry[] {
  // Key metadata by plugin ownership and tool name so only the owning plugin can
  // project display/risk metadata for its own tool.
  const pluginToolMetadata = new Map(
    (getActivePluginRegistry()?.toolMetadata ?? []).map((entry) => [
      buildPluginToolMetadataKey(entry.pluginId, entry.metadata.toolName),
      entry.metadata,
    ]),
  );

  return disambiguateLabels(
    tools
      .flatMap((tool) => {
        const snapshot = snapshotToolInventoryDisplay(tool);
        if (!snapshot) {
          return [];
        }
        const source = resolveEffectiveToolSource(tool, rawToolsByName.get(snapshot.name));
        const metadata = source.pluginId
          ? pluginToolMetadata.get(buildPluginToolMetadataKey(source.pluginId, snapshot.name))
          : undefined;
        const description =
          normalizeOptionalString(metadata?.description) ?? summarizeToolDescription(snapshot);
        return [
          Object.assign(
            {
              id: snapshot.name,
              label:
                normalizeOptionalString(metadata?.displayName) ??
                resolveEffectiveToolLabel(snapshot),
              description,
              rawDescription:
                normalizeOptionalString(metadata?.description) ??
                (snapshot.rawDescription || description),
              ...(metadata?.risk ? { risk: metadata.risk } : {}),
              ...(metadata?.tags ? { tags: metadata.tags } : {}),
            },
            source,
          ) satisfies EffectiveToolInventoryEntry,
        ];
      })
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );
}

/** Normalizes tools, quarantines incompatible schemas, and returns inventory output. */
export function buildRuntimeCompatibleToolInventory(params: {
  tools: readonly AnyAgentTool[];
  cfg: OpenClawConfig;
  workspaceDir?: string;
  modelProvider?: string;
  modelId?: string;
  modelApi?: string | null;
  runtimeModel?: ProviderRuntimeModel;
}): {
  entries: EffectiveToolInventoryEntry[];
  notices: EffectiveToolInventoryNotice[];
} {
  const rawToolsByName = buildReadableRawToolsByName(params.tools);
  const preNormalizationProjection = filterProviderNormalizableTools(params.tools);
  const preNormalizationDiagnostics: RuntimeToolSchemaDiagnostic[] = [
    ...preNormalizationProjection.diagnostics,
  ];
  const normalizedTools = normalizeAgentRuntimeTools({
    // Schema normalization can replace tool definitions, so hand the runtime
    // policy a mutable copy while keeping this inventory API readonly.
    tools: preNormalizationProjection.tools.flatMap((tool) => {
      const safeTool = snapshotToolForInventoryNormalization(tool);
      return safeTool ? [safeTool] : [];
    }),
    provider: params.modelProvider ?? "",
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    modelApi: params.modelApi ?? undefined,
    model: params.runtimeModel,
    onPreNormalizationSchemaDiagnostics: (diagnostics) =>
      preNormalizationDiagnostics.push(...diagnostics),
  });
  const projection = filterRuntimeCompatibleTools(normalizedTools);
  const diagnostics = [...preNormalizationDiagnostics, ...projection.diagnostics];
  return {
    entries: buildEffectiveToolInventoryEntries(projection.tools, rawToolsByName),
    notices: buildUnsupportedToolSchemaNotices({
      diagnostics,
      tools: normalizedTools,
      rawToolsByName,
    }),
  };
}

export { buildEffectiveToolInventoryGroups };
