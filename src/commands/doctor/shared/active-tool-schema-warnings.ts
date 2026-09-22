import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { RuntimeToolSchemaDiagnostic } from "../../../agents/tool-schema-projection.js";
import type { AnyAgentTool } from "../../../agents/tools/common.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { PluginMetadataSnapshotScopeRunner } from "../../../plugins/current-plugin-metadata-snapshot.js";
import type { extractModelCompat } from "../../../plugins/provider-model-compat.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import { getPluginToolMeta } from "../../../plugins/tool-metadata.js";

type RuntimeModelContext = {
  modelApi?: string;
  model?: ProviderRuntimeModel;
  modelCompat?: ReturnType<typeof extractModelCompat>;
  modelContextWindowTokens?: number;
};

async function resolveRuntimeModelContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  modelId: string;
}): Promise<RuntimeModelContext> {
  const { resolveModelAsync } = await import("../../../agents/embedded-agent-runner/model.js");
  const { extractModelCompat } = await import("../../../plugins/provider-model-compat.js");
  // Doctor diagnostics resolve static model facts without publishing a live agent generation.
  const resolution = await resolveModelAsync(
    params.provider,
    params.modelId,
    params.agentDir,
    params.cfg,
    {
      modelIdSource: "selected",
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      skipAgentDiscovery: true,
      allowBundledStaticCatalogFallback: true,
    },
  );
  const model = resolution.model as ProviderRuntimeModel | undefined;
  if (!model) {
    return {};
  }
  return {
    modelApi: model.api,
    model,
    modelCompat: extractModelCompat(model),
    ...(typeof model.contextWindow === "number"
      ? { modelContextWindowTokens: model.contextWindow }
      : {}),
  };
}

function formatDiagnostic(params: {
  agentId: string;
  diagnostic: RuntimeToolSchemaDiagnostic;
  pluginId?: string;
}): string {
  const plugin = params.pluginId ? ` from plugin "${params.pluginId}"` : "";
  return sanitizeForLog(
    `- agents.${params.agentId}: active tool "${params.diagnostic.toolName}"${plugin} has unsupported runtime input schema (${params.diagnostic.violations.join(", ")}). OpenClaw will quarantine this tool at runtime; fix or disable the plugin, or remove the tool from active allowlists.`,
  );
}

function readToolByIndex(tools: readonly AnyAgentTool[], index: number): AnyAgentTool | undefined {
  try {
    return tools[index];
  } catch {
    return undefined;
  }
}

function readPluginId(tool: AnyAgentTool | undefined): string | undefined {
  try {
    return tool ? getPluginToolMeta(tool)?.pluginId : undefined;
  } catch {
    return undefined;
  }
}

/** Collect per-agent warnings for active plugin tools rejected by runtime schema projection. */
export async function collectActiveToolSchemaProjectionWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
}): Promise<string[]> {
  if (params.cfg.plugins?.enabled === false) {
    return [];
  }

  // Disabled plugin diagnostics must not load the agent/tool runtime.
  const { listAgentIds, resolveAgentConfig, resolveAgentDir, resolveAgentWorkspaceDir } =
    await import("../../../agents/agent-scope.js");
  const { createOpenClawCodingTools } = await import("../../../agents/agent-tools.js");
  const { normalizeAgentRuntimeTools } = await import("../../../agents/runtime-plan/tools.js");
  const { filterRuntimeCompatibleTools } =
    await import("../../../agents/tool-schema-projection.js");
  const { buildReadableToolsByName } =
    await import("../../../agents/tools-effective-inventory-build.js");
  const { resolveDoctorPrimaryModelRef } = await import("./primary-model-ref.js");

  const env = params.env ?? process.env;
  const warnings: string[] = [];
  for (const agentId of listAgentIds(params.cfg)) {
    const agentConfig = resolveAgentConfig(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId, env);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId, env);
    const collectForAgent = async (): Promise<string[]> => {
      const agentWarnings: string[] = [];
      const modelRef = resolveDoctorPrimaryModelRef(params.cfg, agentConfig?.model);
      let runtimeModelContext: RuntimeModelContext = {};
      try {
        runtimeModelContext = await resolveRuntimeModelContext({
          cfg: params.cfg,
          agentId,
          agentDir,
          workspaceDir,
          provider: modelRef.provider,
          modelId: modelRef.model,
        });
      } catch (error) {
        agentWarnings.push(
          sanitizeForLog(
            `- agents.${agentId}: active tool schema validation could not resolve the runtime model context (${formatErrorMessage(error)}). Fix provider/model loading errors before relying on assistant tool startup.`,
          ),
        );
      }
      let tools: ReturnType<typeof createOpenClawCodingTools>;
      try {
        tools = createOpenClawCodingTools({
          agentId,
          agentDir,
          workspaceDir,
          config: params.cfg,
          modelProvider: modelRef.provider,
          modelId: modelRef.model,
          modelApi: runtimeModelContext.modelApi,
          modelCompat: runtimeModelContext.modelCompat,
          modelContextWindowTokens: runtimeModelContext.modelContextWindowTokens,
          allowGatewaySubagentBinding: true,
        });
      } catch (error) {
        agentWarnings.push(
          sanitizeForLog(
            `- agents.${agentId}: active tool schema validation could not load the runtime tool set (${formatErrorMessage(error)}). Fix plugin loading errors before relying on assistant tool startup.`,
          ),
        );
        return agentWarnings;
      }

      const rawToolsByName = buildReadableToolsByName(tools);
      const preNormalizationDiagnostics: RuntimeToolSchemaDiagnostic[] = [];
      let normalizedTools: typeof tools;
      try {
        normalizedTools = normalizeAgentRuntimeTools({
          tools,
          provider: modelRef.provider,
          config: params.cfg,
          workspaceDir,
          env,
          modelId: modelRef.model,
          modelApi: runtimeModelContext.modelApi,
          model: runtimeModelContext.model,
          onPreNormalizationSchemaDiagnostics: (diagnostics) =>
            preNormalizationDiagnostics.push(...diagnostics),
        });
      } catch (error) {
        agentWarnings.push(
          sanitizeForLog(
            `- agents.${agentId}: active tool schema validation could not normalize the runtime tool set (${formatErrorMessage(error)}). Fix provider/plugin loading errors before relying on assistant tool startup.`,
          ),
        );
        return agentWarnings;
      }
      for (const diagnostic of preNormalizationDiagnostics) {
        const rawTool = rawToolsByName.get(diagnostic.toolName);
        const pluginId = readPluginId(rawTool);
        agentWarnings.push(
          formatDiagnostic({
            agentId,
            diagnostic,
            ...(pluginId ? { pluginId } : {}),
          }),
        );
      }
      const projection = filterRuntimeCompatibleTools(normalizedTools);
      for (const diagnostic of projection.diagnostics) {
        const tool = readToolByIndex(normalizedTools, diagnostic.toolIndex);
        const rawTool = rawToolsByName.get(diagnostic.toolName);
        const pluginId = readPluginId(tool) ?? readPluginId(rawTool);
        agentWarnings.push(
          formatDiagnostic({
            agentId,
            diagnostic,
            ...(pluginId ? { pluginId } : {}),
          }),
        );
      }
      return agentWarnings;
    };
    warnings.push(
      ...(params.runWithPluginMetadataSnapshot
        ? await params.runWithPluginMetadataSnapshot(
            { config: params.cfg, workspaceDir },
            collectForAgent,
          )
        : await collectForAgent()),
    );
  }

  return warnings;
}
