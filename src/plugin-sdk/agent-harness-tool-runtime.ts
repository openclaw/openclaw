// Keep Tool Search and Code Mode dependencies out of the lightweight harness lifecycle SDK.
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";

export { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
export {
  normalizeAcceptedSessionSpawnResult,
  type AcceptedSessionSpawn,
} from "../agents/accepted-session-spawn.js";
export { getCoreTtsToolResultMediaUrls } from "../agents/tools/tts-tool-result-provenance.js";
export { consumeTrustedToolNoStartError } from "../agents/tool-result-error.js";
export {
  recordAgentHarnessMessagingDelivery,
  recordAgentHarnessToolResultTelemetry,
  collectAgentHarnessMessagingMediaUrls,
  type AgentHarnessToolResultTelemetry,
  recordAgentHarnessToolResultMedia,
  type AgentHarnessMessagingDeliveryFacts,
  type AgentHarnessToolMediaFacts,
} from "../agents/harness/tool-result-facts.js";
export { runAgentHarnessToolInvocation } from "../agents/harness/tool-invocation.js";
export { runWithToolExecutionValidation } from "../agents/agent-tools.execution-validation.js";
export {
  createAgentHarnessToolExecutionRegistry,
  createAgentHarnessToolExecutionBoundaryRegistry,
  type AgentHarnessToolExecutionSnapshot,
} from "../agents/harness/tool-execution.js";
export {
  acknowledgeInternalToolResult,
  copyInternalToolResultState,
} from "../agents/runtime/internal-hooks.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<typeof import("./agent-harness.js").createOpenClawCodingTools>[0]
>;

type CoreCompactTools = ReturnType<typeof createAgentHarnessToolSurfaceRuntimeCore>["compactTools"];
export type AgentHarnessToolSurfaceRuntime = ReturnType<
  typeof createAgentHarnessToolSurfaceRuntime
>;

export type AgentHarnessToolSurfaceRuntimeParams = Omit<
  Parameters<typeof createAgentHarnessToolSurfaceRuntimeCore>[0],
  "executeTool" | "disableToolSearch" | "forceCodeModeControls"
> & {
  executeTool: NonNullable<OpenClawCodingToolsOptions["toolSearchCatalogExecutor"]>;
};

export function createAgentHarnessToolSurfaceRuntime(params: AgentHarnessToolSurfaceRuntimeParams) {
  const runtime = createAgentHarnessToolSurfaceRuntimeCore(params);
  const catalog: Pick<
    OpenClawCodingToolsOptions,
    "toolSearchCatalogExecutor" | "toolSearchCatalogRef"
  > = runtime;
  return {
    codeModeControlsEnabled: runtime.codeModeControlsEnabled,
    config: runtime.config,
    includeToolSearchControls: runtime.includeToolSearchControls,
    runtimeToolAllowlist: runtime.runtimeToolAllowlist,
    toolSearchCatalogExecutor: catalog.toolSearchCatalogExecutor,
    toolSearchCatalogRef: catalog.toolSearchCatalogRef,
    toolSearchControlsEnabled: runtime.toolSearchControlsEnabled,
    cleanup: runtime.cleanup,
    compactTools: (
      tools: Parameters<CoreCompactTools>[0],
      {
        hookContext,
        localModelLeanApplied,
      }: Pick<
        NonNullable<Parameters<CoreCompactTools>[1]>,
        "hookContext" | "localModelLeanApplied"
      > = {},
    ) => {
      const { tools: compacted, promptToolPolicy } = runtime.compactTools(tools, {
        hookContext,
        localModelLeanApplied,
      });
      return { tools: compacted, promptToolPolicy };
    },
  };
}
