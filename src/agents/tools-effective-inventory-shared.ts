import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";
import { summarizeToolDescriptionText } from "./tool-description-summary.js";
import { resolveToolDisplay } from "./tool-display.js";
import {
  filterRuntimeCompatibleTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryNotice,
  ResolveEffectiveToolInventoryParams,
} from "./tools-effective-inventory.types.js";
import type { AnyAgentTool } from "./tools/common.js";

function resolveEffectiveToolLabel(tool: AnyAgentTool): string {
  const rawLabel = normalizeOptionalString(tool.label) ?? "";
  if (
    rawLabel &&
    normalizeLowercaseStringOrEmpty(rawLabel) !== normalizeLowercaseStringOrEmpty(tool.name)
  ) {
    return rawLabel;
  }
  return resolveToolDisplay({ name: tool.name }).title;
}

function summarizeEffectiveToolDescription(tool: AnyAgentTool): string {
  return summarizeToolDescriptionText({
    rawDescription: normalizeOptionalString(tool.description),
    displaySummary: tool.displaySummary,
  });
}

export type RuntimeCompatibleToolInventoryParams = Pick<
  ResolveEffectiveToolInventoryParams,
  "cfg" | "workspaceDir" | "modelProvider" | "modelId" | "modelApi" | "runtimeModel"
> & {
  tools: readonly AnyAgentTool[];
};

type ToolInventoryProjection = Omit<
  EffectiveToolInventoryEntry,
  "id" | "label" | "description" | "rawDescription"
> &
  Partial<Pick<EffectiveToolInventoryEntry, "label" | "description" | "rawDescription">>;

export function buildEffectiveToolInventory(
  params: RuntimeCompatibleToolInventoryParams,
  projection: {
    createToolProjection: () => (tool: AnyAgentTool) => ToolInventoryProjection;
    diagnosticOwner: (
      diagnostic: RuntimeToolSchemaDiagnostic,
      tools: readonly AnyAgentTool[],
    ) => string;
    allowProviderRuntimePluginLoad?: false;
    rawDescriptionFallback?: "summary";
  },
): { entries: EffectiveToolInventoryEntry[]; notices: EffectiveToolInventoryNotice[] } {
  const diagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const normalizedTools = normalizeAgentRuntimeTools({
    tools: params.tools,
    provider: params.modelProvider ?? "",
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    modelApi: params.modelApi ?? undefined,
    model: params.runtimeModel,
    allowProviderRuntimePluginLoad: projection.allowProviderRuntimePluginLoad,
    onPreNormalizationSchemaDiagnostics: (found) => diagnostics.push(...found),
  });
  const compatible = filterRuntimeCompatibleTools(normalizedTools);
  diagnostics.push(...compatible.diagnostics);
  const projectTool = projection.createToolProjection();
  const entries: EffectiveToolInventoryEntry[] = [];
  for (const tool of compatible.tools) {
    const projected = projectTool(tool);
    const description = projected.description ?? summarizeEffectiveToolDescription(tool);
    entries.push({
      id: tool.name,
      ...projected,
      label: projected.label ?? resolveEffectiveToolLabel(tool),
      description,
      rawDescription:
        projected.rawDescription ??
        (normalizeOptionalString(tool.description) ||
          (projection.rawDescriptionFallback === "summary" ? description : "")),
    });
  }
  entries.sort((a, b) => a.label.localeCompare(b.label));
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }
  for (const entry of entries) {
    if ((counts.get(entry.label) ?? 0) > 1) {
      entry.label = `${entry.label} (${entry.pluginId ?? entry.channelId ?? entry.id})`;
    }
  }
  return {
    entries,
    notices: diagnostics.map((diagnostic) => ({
      id: `unsupported-tool-schema:${diagnostic.toolName}`,
      severity: "warning",
      message: `Tool "${diagnostic.toolName}"${projection.diagnosticOwner(diagnostic, normalizedTools)} has an unsupported runtime input schema (${diagnostic.violations.join(", ")}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
    })),
  };
}
