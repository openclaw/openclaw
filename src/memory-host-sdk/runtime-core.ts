// Focused runtime contract for memory plugin config/state/helpers.

export type { AnyAgentTool } from "../agents/tools/common.js";
export { resolveCronStyleNow } from "../agents/current-time.js";
export { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../agents/pi-settings.js";
export { resolveDefaultAgentId, resolveSessionAgentId } from "../agents/agent-scope.js";
export { resolveMemorySearchConfig } from "../agents/memory-search.js";
export { jsonResult, readNumberParam, readStringParam } from "../agents/tools/common.js";
export { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
export { parseNonNegativeByteSize } from "../config/byte-size.js";
export { loadConfig } from "../config/config.js";
export { resolveStateDir } from "../config/paths.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
import { resolveRuntimePluginRegistry } from "../plugins/loader.js";
export { buildMemoryPromptSection as buildActiveMemoryPromptSection } from "../plugins/memory-state.js";
import { listActiveMemoryPublicArtifacts as listActiveMemoryPublicArtifactsFromState } from "../plugins/memory-state.js";
export { parseAgentSessionKey } from "../routing/session-key.js";
import type { OpenClawConfig } from "../config/config.js";
export type { OpenClawConfig } from "../config/config.js";
export type { MemoryCitationsMode } from "../config/types.memory.js";
export type {
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
} from "../plugins/memory-state.js";
export type { OpenClawPluginApi } from "../plugins/types.js";

export async function listActiveMemoryPublicArtifacts(params: { cfg: OpenClawConfig }) {
  const current = await listActiveMemoryPublicArtifactsFromState(params);
  if (current.length > 0) {
    return current;
  }
  resolveRuntimePluginRegistry({
    config: params.cfg,
    workspaceDir: params.cfg.agents?.defaults?.workspace,
    runtimeOptions: {
      allowGatewaySubagentBinding: true,
    },
  });
  return listActiveMemoryPublicArtifactsFromState(params);
}
