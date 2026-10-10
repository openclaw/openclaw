import type { AgentToolSurfacePresentation } from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import {
  applyCodeModeCatalog,
  isCodeModeEngagedForModel,
  resolveCodeModeConfig,
} from "./code-mode.js";
import type { EmbeddedRunTrigger } from "./run-trigger.js";
import { normalizeToolPolicyName, readToolAllowlistIntersection } from "./tool-policy-shared.js";
import { resolveAgentToolSearchRuntimeConfig } from "./tool-search-runtime-config.js";
import type { ToolSearchConfig } from "./tool-search-types.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";

export type AgentToolSurfacePlanParams = {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  forceDirectMessageTool: boolean;
  model?: { compat?: unknown; toolSearchMode?: "tools" | false };
  modelProvider?: string;
  modelId?: string;
  codeModeOverride?: boolean | "auto";
  disableToolSearch?: true;
  toolsEnabled: boolean;
  disableTools?: boolean;
  isRawModelRun: boolean;
  toolsAllow?: readonly string[];
  forceCodeModeControls?: boolean;
  trigger?: EmbeddedRunTrigger;
};

export function resolveAgentToolSurfacePlan(params: AgentToolSurfacePlanParams) {
  const restrictions = params.toolsAllow
    ? (readToolAllowlistIntersection(params.toolsAllow) ?? [params.toolsAllow])
    : [];
  // Private completion replies have one message capability. Ordinary forced
  // delivery keeps message direct while other tools can still use discovery.
  const completionPrivateMessageOnly =
    params.forceDirectMessageTool &&
    restrictions.some(
      (allow) => allow.length === 1 && normalizeToolPolicyName(allow[0] ?? "") === "message",
    );
  const codeModeConfig = resolveCodeModeConfig(
    params.config,
    params.agentId,
    params.modelProvider && params.modelId
      ? { provider: params.modelProvider, modelId: params.modelId }
      : undefined,
  );
  codeModeConfig.enabled = params.codeModeOverride ?? codeModeConfig.enabled;
  const selectedToolConfig = resolveAgentToolSearchRuntimeConfig({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    completionPrivateMessageOnly,
    model: params.model,
  });
  // Apply restrictions after snapshot selection so config rebinding cannot
  // restore discovery for direct-tool or persistence-only turns.
  const isMemoryFlushRun = params.trigger === "memory";
  const toolSearchRuntimeConfig =
    params.disableToolSearch || isMemoryFlushRun
      ? {
          ...selectedToolConfig,
          tools: { ...selectedToolConfig?.tools, toolSearch: false as const },
        }
      : selectedToolConfig;
  const toolSearchConfig = resolveToolSearchConfig(toolSearchRuntimeConfig);
  const toolsAvailable =
    params.toolsEnabled &&
    !isMemoryFlushRun &&
    getActiveAgentRingZeroTools().length === 0 &&
    params.disableTools !== true &&
    !params.isRawModelRun &&
    restrictions.every((allow) => allow.length > 0) &&
    !completionPrivateMessageOnly;
  const codeModeControlsEnabled =
    toolsAvailable &&
    // Restart recovery continues one provider turn. Keep its original control
    // schema even when the reloaded config disables Code Mode for new turns.
    (params.forceCodeModeControls === true ||
      isCodeModeEngagedForModel(codeModeConfig, params.model));
  const toolSearchControlsEnabled =
    toolsAvailable && !codeModeControlsEnabled && toolSearchConfig.enabled;
  return {
    codeModeConfig,
    codeModeControlsEnabled,
    toolSearchControlsEnabled,
    toolSearchConfig,
    toolSearchRuntimeConfig,
  };
}

/** Only resolved presentation facts cross a placement boundary; runtime config stays on its owner. */
export function prepareAgentToolSurfacePresentation(
  params: AgentToolSurfacePlanParams,
): AgentToolSurfacePresentation {
  const plan = resolveAgentToolSurfacePlan(params);
  return {
    codeMode: { ...plan.codeModeConfig, enabled: plan.codeModeControlsEnabled },
    toolSearch: { ...plan.toolSearchConfig, enabled: plan.toolSearchControlsEnabled },
    forceDirectMessageTool: params.forceDirectMessageTool,
  };
}

type CodeModeCatalogParams = Parameters<typeof applyCodeModeCatalog>[0];
type ApplyAgentToolSurfaceCatalogParams = Omit<CodeModeCatalogParams, "directToolNames"> & {
  /** Required key (may be undefined for a config-less run): the tool-search
   * branches resolve their mode from this, so omitting it would silently
   * downgrade the run to schema defaults. */
  toolSearchRuntimeConfig: OpenClawConfig | undefined;
  codeModeControlsEnabled: boolean;
  toolSearchConfig: ToolSearchConfig;
  forceDirectMessageTool: boolean;
};

export function applyAgentToolSurfaceCatalog({
  codeModeControlsEnabled,
  toolSearchConfig,
  toolSearchRuntimeConfig,
  forceDirectMessageTool,
  ...catalogParams
}: ApplyAgentToolSurfaceCatalogParams) {
  // When the message tool is the only reply path it must stay directly visible
  // in every search mode; a hidden delivery tool can leave the run mute.
  const directToolNames = forceDirectMessageTool ? ["message"] : [];
  const applyCatalog = codeModeControlsEnabled
    ? applyCodeModeCatalog
    : toolSearchConfig.mode === "directory"
      ? applyToolSchemaDirectoryCatalog
      : applyToolSearchCatalog;
  return applyCatalog({
    ...catalogParams,
    config: codeModeControlsEnabled ? catalogParams.config : toolSearchRuntimeConfig,
    directToolNames,
  });
}
