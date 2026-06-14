/**
 * Builds the operator-facing effective inventory for bundle MCP tools. Runtime
 * schema policy quarantines incompatible tools and emits notices instead of
 * silently hiding them.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryNotice,
} from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

type McpToolInventoryDisplaySnapshot = {
  name: string;
  label: string;
  rawDescription: string;
  displaySummary?: string;
};

const BUNDLE_MCP_PLUGIN_ID = "bundle-mcp";

function readMcpToolInventoryStringField(
  tool: AnyAgentTool,
  field: "description" | "displaySummary" | "label" | "name",
): string | undefined {
  try {
    return normalizeOptionalString((tool as unknown as Record<string, unknown>)[field]);
  } catch {
    return undefined;
  }
}

function readMcpToolInventoryUnknownField(tool: AnyAgentTool, field: "parameters"): unknown {
  try {
    return (tool as unknown as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function snapshotMcpToolInventoryDisplay(
  tool: AnyAgentTool,
): McpToolInventoryDisplaySnapshot | undefined {
  const name = readMcpToolInventoryStringField(tool, "name");
  if (!name) {
    return undefined;
  }
  const displaySummary = readMcpToolInventoryStringField(tool, "displaySummary");
  return {
    name,
    label: readMcpToolInventoryStringField(tool, "label") ?? "",
    rawDescription: readMcpToolInventoryStringField(tool, "description") ?? "",
    ...(displaySummary ? { displaySummary } : {}),
  };
}

function snapshotMcpToolForInventoryNormalization(tool: AnyAgentTool): AnyAgentTool | undefined {
  const snapshot = snapshotMcpToolInventoryDisplay(tool);
  if (!snapshot) {
    return undefined;
  }
  return {
    name: snapshot.name,
    label: snapshot.label,
    description: snapshot.rawDescription,
    parameters: readMcpToolInventoryUnknownField(tool, "parameters"),
    execute: async () => ({ text: "" }),
    ...(snapshot.displaySummary ? { displaySummary: snapshot.displaySummary } : {}),
  } as unknown as AnyAgentTool;
}

function resolveMcpToolLabel(snapshot: McpToolInventoryDisplaySnapshot): string {
  const rawLabel = snapshot.label;
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(snapshot.name)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: snapshot.name }).title;
}

function summarizeToolDescription(snapshot: McpToolInventoryDisplaySnapshot): string {
  return summarizeToolDescriptionText({
    rawDescription: snapshot.rawDescription,
    displaySummary: snapshot.displaySummary,
  });
}

// Runtime schema diagnostics become operator-facing notices on the effective
// inventory screen instead of silently hiding quarantined MCP tools.
function buildMcpUnsupportedToolSchemaNotice(
  diagnostic: RuntimeToolSchemaDiagnostic,
): EffectiveToolInventoryNotice {
  return {
    id: `unsupported-tool-schema:${diagnostic.toolName}`,
    severity: "warning",
    message: `Tool "${diagnostic.toolName}" from plugin "${BUNDLE_MCP_PLUGIN_ID}" has an unsupported runtime input schema (${diagnostic.violations.join(", ")}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
  };
}

// Duplicate labels are ambiguous in inventory UIs; add the plugin/id only where
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
    return { ...entry, label: `${entry.label} (${entry.pluginId ?? entry.id})` };
  });
}

function buildMcpToolInventoryEntries(
  tools: readonly AnyAgentTool[],
): EffectiveToolInventoryEntry[] {
  return disambiguateLabels(
    tools
      .flatMap((tool) => {
        const snapshot = snapshotMcpToolInventoryDisplay(tool);
        if (!snapshot) {
          return [];
        }
        const description = summarizeToolDescription(snapshot);
        return [
          {
            id: snapshot.name,
            label: resolveMcpToolLabel(snapshot),
            description,
            rawDescription: snapshot.rawDescription || description,
            source: "mcp",
            pluginId: BUNDLE_MCP_PLUGIN_ID,
          } satisfies EffectiveToolInventoryEntry,
        ];
      })
      .toSorted((a, b) => a.label.localeCompare(b.label)),
  );
}

/** Builds the runtime-compatible MCP tool inventory and quarantine notices. */
export function buildRuntimeCompatibleMcpToolInventory(params: {
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
  const preNormalizationProjection = filterProviderNormalizableTools(params.tools);
  const preNormalizationDiagnostics: RuntimeToolSchemaDiagnostic[] = [
    ...preNormalizationProjection.diagnostics,
  ];
  const normalizedTools = normalizeAgentRuntimeTools({
    tools: preNormalizationProjection.tools.flatMap((tool) => {
      const safeTool = snapshotMcpToolForInventoryNormalization(tool);
      return safeTool ? [safeTool] : [];
    }),
    provider: params.modelProvider ?? "",
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    modelApi: params.modelApi ?? undefined,
    model: params.runtimeModel,
    allowProviderRuntimePluginLoad: false,
    onPreNormalizationSchemaDiagnostics: (diagnostics) =>
      preNormalizationDiagnostics.push(...diagnostics),
  });
  const projection = filterRuntimeCompatibleTools(normalizedTools);
  const diagnostics = [...preNormalizationDiagnostics, ...projection.diagnostics];
  return {
    entries: buildMcpToolInventoryEntries(projection.tools),
    notices: diagnostics.map(buildMcpUnsupportedToolSchemaNotice),
  };
}
