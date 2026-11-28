import type { AgentToolSurfacePresentation } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { resolveCodeModeConfig } from "../../agents/code-mode-runtime.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import {
  loadManifestModelCatalog,
  overlayConfiguredModelCatalog,
} from "../../agents/model-catalog.js";
import { supportsModelTools } from "../../agents/model-tool-support.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import {
  prepareAgentToolSurfacePresentation,
  type AgentToolSurfacePlanParams,
} from "../../agents/tool-surface-plan.js";
import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertWorkerPluginCodeModeExecutorAllowed } from "../../plugins/code-mode-executor.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

type ModelRef = { provider: string; model: string };

export function prepareWorkerToolPresentation(params: {
  turn?: SessionPlacementTurnParams;
  config?: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  modelRef: ModelRef;
  model?: AgentToolSurfacePlanParams["model"];
  metadataSnapshot?: PluginMetadataSnapshot;
}): AgentToolSurfacePresentation {
  const { turn, config, agentId, sessionKey, modelRef, model, metadataSnapshot } = params;
  const presentation = prepareAgentToolSurfacePresentation({
    ...turn,
    config,
    agentId,
    sessionKey: turn?.sandboxSessionKey ?? sessionKey,
    model,
    modelProvider: modelRef.provider,
    modelId: modelRef.model,
    toolsEnabled: supportsModelTools(model ?? {}),
    forceDirectMessageTool: turn ? messageToolOwnsVisibleReply(turn) : false,
    isRawModelRun: turn?.modelRun === true || turn?.promptMode === "none",
  });
  const { codeMode } = presentation;
  if (codeMode.enabled && codeMode.executor !== "node") {
    assertWorkerPluginCodeModeExecutorAllowed(codeMode.executor, config, metadataSnapshot);
  }
  return presentation;
}

/** Reject known incompatible selections before allocation. The admitted turn checks unknowns. */
export function assertWorkerCodeModeExecutorSupported(params: {
  config: OpenClawConfig;
  agentId: string;
  modelRef: ModelRef;
  metadataSnapshot: PluginMetadataSnapshot;
  turn?: SessionPlacementTurnParams;
}): void {
  const { config, agentId, modelRef, metadataSnapshot, turn } = params;
  const configured = resolveCodeModeConfig(config, agentId, {
    provider: modelRef.provider,
    modelId: modelRef.model,
  });
  if (configured.executor === "node" || (turn?.codeModeOverride ?? configured.enabled) === false) {
    return;
  }
  const model = findModelInCatalog(
    overlayConfiguredModelCatalog({
      catalog: loadManifestModelCatalog({ config, metadataSnapshot }),
      config,
      workspaceDir: turn?.workspaceDir,
    }),
    modelRef.provider,
    modelRef.model,
  );
  if (!model) {
    return;
  }
  prepareWorkerToolPresentation({ ...params, model });
}

export function assertWorkerTurnCodeModeExecutorSupported(
  turn: SessionPlacementTurnParams,
  agentId: string,
): void {
  if (!turn.config || !turn.provider?.trim() || !turn.model?.trim()) {
    return;
  }
  const metadataSnapshot =
    turn.pluginGeneration?.pluginMetadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: turn.config,
      allowWorkspaceScopedSnapshot: true,
      allowSynchronousPolicyRead: false,
    });
  if (metadataSnapshot) {
    assertWorkerCodeModeExecutorSupported({
      config: turn.config,
      agentId,
      modelRef: { provider: turn.provider.trim(), model: turn.model.trim() },
      metadataSnapshot,
      turn,
    });
  }
}
