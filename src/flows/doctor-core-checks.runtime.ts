import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  type ModelCatalogEntry,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { supportsModelTools } from "../agents/model-tool-support.js";
import { createBundleMcpToolRuntime } from "../agents/pi-bundle-mcp-tools.js";
import { applyFinalEffectiveToolPolicy } from "../agents/pi-embedded-runner/effective-tool-policy.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "../agents/pi-embedded-runner/run/attempt-tool-construction-plan.js";
import { createOpenClawCodingTools } from "../agents/pi-tools.js";
import { normalizeAgentRuntimeTools } from "../agents/runtime-plan/tools.js";
import { buildWorkspaceSkillStatus, type SkillStatusEntry } from "../agents/skills-status.js";
import {
  inspectRuntimeToolInputSchemas,
  type RuntimeToolSchemaDiagnostic,
} from "../agents/tool-schema-projection.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { collectUnavailableAgentSkills } from "../commands/doctor-skills-core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import type { HealthFinding } from "./health-checks.js";

export function detectUnavailableSkills(cfg: OpenClawConfig): SkillStatusEntry[] {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId,
  });
  return collectUnavailableAgentSkills(report);
}

function buildDoctorRuntimeModel(params: {
  entry?: ModelCatalogEntry;
  provider: string;
  modelId: string;
}): ProviderRuntimeModel {
  const provider = params.provider || DEFAULT_PROVIDER;
  const id = params.modelId || DEFAULT_MODEL;
  const api =
    provider === "openai-codex"
      ? "openai-codex-responses"
      : provider === "openai"
        ? "openai-responses"
        : undefined;
  const baseUrl =
    provider === "openai-codex"
      ? "https://chatgpt.com/backend-api"
      : provider === "openai"
        ? "https://api.openai.com/v1"
        : undefined;
  return {
    ...params.entry,
    provider,
    id,
    name: params.entry?.name ?? id,
    ...(api ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  } as ProviderRuntimeModel;
}

function toolSchemaDiagnosticToFinding(params: {
  tools: readonly AnyAgentTool[];
  diagnostic: RuntimeToolSchemaDiagnostic;
}): HealthFinding {
  const tool = params.tools[params.diagnostic.toolIndex];
  const pluginId = tool ? getPluginToolMeta(tool)?.pluginId : undefined;
  const owner = pluginId ? ` from plugin ${pluginId}` : "";
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
    message: `Tool ${params.diagnostic.toolName}${owner} has an unsupported input schema for runtime projection.`,
    path,
    target: params.diagnostic.toolName,
    requirement: params.diagnostic.violations.join(", "),
    fixHint,
  };
}

function collectToolSchemaFindings(tools: readonly AnyAgentTool[]): HealthFinding[] {
  return inspectRuntimeToolInputSchemas(tools).map((diagnostic) =>
    toolSchemaDiagnosticToFinding({
      tools,
      diagnostic,
    }),
  );
}

async function collectBundleMcpRuntimeToolSchemaFindings(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  modelRef: { provider: string; model: string };
  model: ProviderRuntimeModel;
}): Promise<readonly HealthFinding[]> {
  if (
    !shouldCreateBundleMcpRuntimeForAttempt({
      toolsEnabled: true,
    })
  ) {
    return [];
  }

  let bundleRuntime: Awaited<ReturnType<typeof createBundleMcpToolRuntime>> | undefined;
  try {
    bundleRuntime = await createBundleMcpToolRuntime({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
    });
    const activeBundleTools = applyFinalEffectiveToolPolicy({
      bundledTools: bundleRuntime.tools,
      config: params.cfg,
      agentId: params.agentId,
      modelProvider: params.modelRef.provider,
      modelId: params.modelRef.model,
      warn: () => {},
    });
    const normalizedTools = normalizeAgentRuntimeTools({
      tools: activeBundleTools,
      provider: params.modelRef.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      modelId: params.modelRef.model,
      modelApi: params.model.api,
      model: params.model,
    });
    return collectToolSchemaFindings(normalizedTools);
  } catch (error) {
    return [
      {
        checkId: "core/doctor/runtime-tool-schemas",
        severity: "error",
        message: "Configured MCP tool schema validation could not load the runtime tool set.",
        path: "mcp.servers",
        requirement: formatErrorMessage(error),
        fixHint:
          "Fix or disable the offending MCP server, then rerun doctor before relying on assistant tool startup.",
      },
    ];
  } finally {
    await bundleRuntime?.dispose();
  }
}

export async function collectRuntimeToolSchemaFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const modelRef = resolveDefaultModelForAgent({
    cfg,
    agentId,
    allowPluginNormalization: true,
  });
  const catalog = await loadModelCatalog({ config: cfg });
  const model = buildDoctorRuntimeModel({
    entry: findModelInCatalog(catalog, modelRef.provider, modelRef.model),
    provider: modelRef.provider,
    modelId: modelRef.model,
  });
  if (!supportsModelTools(model)) {
    return [];
  }
  const tools = createOpenClawCodingTools({
    agentId,
    workspaceDir,
    config: cfg,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
    modelApi: model.api,
    modelCompat: model.compat,
    modelContextWindowTokens: model.contextWindow,
    allowGatewaySubagentBinding: true,
    emitBeforeToolCallDiagnostics: false,
  });
  const normalizedTools = normalizeAgentRuntimeTools({
    tools,
    provider: modelRef.provider,
    config: cfg,
    workspaceDir,
    env: process.env,
    modelId: modelRef.model,
    modelApi: model.api,
    model,
  });
  return [
    ...collectToolSchemaFindings(normalizedTools),
    ...(await collectBundleMcpRuntimeToolSchemaFindings({
      cfg,
      agentId,
      workspaceDir,
      modelRef,
      model,
    })),
  ];
}
