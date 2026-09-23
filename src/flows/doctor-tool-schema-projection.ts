import { normalizeAgentRuntimeTools } from "../agents/runtime-plan/tools.js";
import {
  inspectRuntimeToolInputSchemas,
  type RuntimeToolSchemaDiagnostic,
} from "../agents/tool-schema-projection.js";
import { buildReadableToolsByName } from "../agents/tools-effective-inventory-build.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { DoctorToolSchemaFrame } from "./doctor-tool-schema-frames.js";
import type { HealthFinding } from "./health-checks.js";

function toolSchemaDiagnosticToFinding(params: {
  agentId: string;
  tools: readonly AnyAgentTool[];
  diagnostic: RuntimeToolSchemaDiagnostic;
  rawToolsByName?: ReadonlyMap<string, AnyAgentTool>;
}): HealthFinding {
  let tool: AnyAgentTool | undefined;
  try {
    tool = params.tools[params.diagnostic.toolIndex];
  } catch {
    tool = undefined;
  }
  const rawTool = params.rawToolsByName?.get(params.diagnostic.toolName);
  const pluginId =
    (tool ? getPluginToolMeta(tool)?.pluginId : undefined) ??
    (rawTool ? getPluginToolMeta(rawTool)?.pluginId : undefined);
  const owner = pluginId ? ` from plugin ${pluginId}` : "";
  const agent = `Agent ${params.agentId} `;
  const path =
    pluginId === "bundle-mcp"
      ? "mcp.servers"
      : pluginId
        ? `plugins.entries.${pluginId}`
        : `tools.${params.diagnostic.toolName}`;
  const fixHint =
    pluginId === "bundle-mcp"
      ? "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor."
      : "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.";
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: `${agent}tool ${params.diagnostic.toolName}${owner} has an unsupported input schema for runtime projection.`,
    path,
    target: params.diagnostic.toolName,
    requirement: params.diagnostic.violations.join(", "),
    fixHint,
  };
}

function collectToolSchemaFindings(params: {
  agentId: string;
  tools: readonly AnyAgentTool[];
  rawToolsByName?: ReadonlyMap<string, AnyAgentTool>;
}): HealthFinding[] {
  return inspectRuntimeToolInputSchemas(params.tools).map((diagnostic) =>
    toolSchemaDiagnosticToFinding({
      agentId: params.agentId,
      tools: params.tools,
      rawToolsByName: params.rawToolsByName,
      diagnostic,
    }),
  );
}

export function collectNormalizedToolSchemaFindings(params: {
  agentId: string;
  tools: AnyAgentTool[];
  cfg: OpenClawConfig;
  workspaceDir: string;
  modelRef: { provider: string; model: string };
  model: ProviderRuntimeModel;
  normalizationFailureFinding: (error: unknown) => HealthFinding;
}): readonly HealthFinding[] {
  const preNormalizationFindings: HealthFinding[] = [];
  const rawToolsByName = buildReadableToolsByName(params.tools);

  let normalizedTools: AnyAgentTool[];
  try {
    normalizedTools = normalizeAgentRuntimeTools({
      tools: params.tools,
      provider: params.modelRef.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      modelId: params.modelRef.model,
      modelApi: params.model.api,
      model: params.model,
      onPreNormalizationSchemaDiagnostics: (diagnostics, sourceTools) => {
        preNormalizationFindings.push(
          ...diagnostics.map((diagnostic) =>
            toolSchemaDiagnosticToFinding({
              agentId: params.agentId,
              tools: sourceTools,
              diagnostic,
            }),
          ),
        );
      },
    });
  } catch (error) {
    return [...preNormalizationFindings, params.normalizationFailureFinding(error)];
  }

  return [
    ...preNormalizationFindings,
    ...collectToolSchemaFindings({
      agentId: params.agentId,
      tools: normalizedTools,
      rawToolsByName,
    }),
  ];
}

function agentRuntimeToolLoadFailureFinding(params: {
  agentId: string;
  error: unknown;
}): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: `Agent ${params.agentId} runtime tool schema validation could not load the runtime tool set.`,
    path: `agents.${params.agentId}.tools`,
    requirement: formatErrorMessage(params.error),
    fixHint:
      "Fix provider/plugin tool loading errors, then rerun doctor before relying on assistant tool startup.",
  };
}

function agentRuntimeToolNormalizationFailureFinding(params: {
  agentId: string;
  error: unknown;
}): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: `Agent ${params.agentId} runtime tool schema validation could not normalize the runtime tool set.`,
    path: `agents.${params.agentId}.tools`,
    requirement: formatErrorMessage(params.error),
    fixHint:
      "Fix provider/plugin schema normalization errors, then rerun doctor before relying on assistant tool startup.",
  };
}

export async function collectAgentRuntimeToolSchemaFindings(
  params: DoctorToolSchemaFrame & {
    cfg: OpenClawConfig;
  },
): Promise<readonly HealthFinding[]> {
  let tools: AnyAgentTool[];
  try {
    const { createOpenClawCodingTools } = await import("../agents/agent-tools.js");
    tools = createOpenClawCodingTools({
      agentId: params.agentId,
      agentDir: params.agentDir,
      conversationCapabilityProfile: params.capabilityProfile,
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      modelProvider: params.modelRef.provider,
      modelId: params.modelRef.model,
      modelApi: params.model.api,
      modelCompat: params.model.compat,
      modelContextWindowTokens: params.model.contextWindow,
      allowGatewaySubagentBinding: true,
      emitBeforeToolCallDiagnostics: false,
    });
  } catch (error) {
    return [agentRuntimeToolLoadFailureFinding({ agentId: params.agentId, error })];
  }

  return collectNormalizedToolSchemaFindings({
    agentId: params.agentId,
    tools,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    modelRef: params.modelRef,
    model: params.model,
    normalizationFailureFinding: (error) =>
      agentRuntimeToolNormalizationFailureFinding({
        agentId: params.agentId,
        error,
      }),
  });
}
