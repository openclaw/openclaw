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

const BUNDLE_MCP_PLUGIN_ID = "bundle-mcp";

type McpInventoryTool = {
  name: string;
  label?: string;
  description?: string;
  displaySummary?: string;
};

function readMcpInventoryToolField<TField extends keyof AnyAgentTool>(
  tool: AnyAgentTool,
  field: TField,
): { ok: true; value: AnyAgentTool[TField] } | { ok: false } {
  try {
    return { ok: true, value: tool[field] };
  } catch {
    return { ok: false };
  }
}

function readMcpInventoryToolString<TField extends keyof AnyAgentTool>(
  tool: AnyAgentTool,
  field: TField,
): string | undefined {
  const fieldRead = readMcpInventoryToolField(tool, field);
  return fieldRead.ok ? normalizeOptionalString(fieldRead.value) : undefined;
}

function materializeMcpInventoryTool(tool: AnyAgentTool): McpInventoryTool | undefined {
  const name = readMcpInventoryToolString(tool, "name");
  if (!name) {
    return undefined;
  }
  const label = readMcpInventoryToolString(tool, "label");
  const description = readMcpInventoryToolString(tool, "description");
  const displaySummary = readMcpInventoryToolString(tool, "displaySummary");
  return {
    name,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(displaySummary ? { displaySummary } : {}),
  };
}

function resolveMcpToolLabel(tool: McpInventoryTool): string {
  const rawLabel = tool.label ?? "";
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(tool.name)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: tool.name }).title;
}

function resolveRawToolDescription(tool: McpInventoryTool): string {
  return tool.description ?? "";
}

function summarizeToolDescription(tool: McpInventoryTool): string {
  return summarizeToolDescriptionText({
    rawDescription: resolveRawToolDescription(tool),
    displaySummary: tool.displaySummary,
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
        const materializedTool = materializeMcpInventoryTool(tool);
        if (!materializedTool) {
          return [];
        }
        const summary = summarizeToolDescription(materializedTool);
        return [
          {
            id: materializedTool.name,
            label: resolveMcpToolLabel(materializedTool),
            description: summary,
            rawDescription: resolveRawToolDescription(materializedTool) || summary,
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
    tools: [...preNormalizationProjection.tools],
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
