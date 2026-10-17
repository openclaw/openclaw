/**
 * Config-aware system prompt builder.
 *
 * This module gathers agent/config knobs before rendering the canonical system
 * prompt so callers do not duplicate owner, TTS, alias, memory, or FS policy.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { PreparedTtsPreferences } from "../tts/tts-preferences.js";
import { buildTtsSystemPromptHint } from "../tts/tts-settings.js";
import { resolveMainSessionDelegationMode } from "./delegation-guidance.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";

type ConfiguredAgentSystemPromptParams = Parameters<typeof buildAgentSystemPrompt>[0] & {
  config?: OpenClawConfig;
  agentId?: string;
  preparedTtsPreferences?: PreparedTtsPreferences;
  tools?: { name: string; parameters: unknown }[];
  preparedModelRuntime?: Pick<PreparedModelRuntimeSnapshot, "configuredModelAliases" | "isCurrent">;
};

function buildModelAliasLines(owner: ConfiguredAgentSystemPromptParams["preparedModelRuntime"]) {
  if (!owner?.isCurrent()) {
    return [];
  }
  return (owner.configuredModelAliases ?? [])
    .toSorted((a, b) => a.alias.localeCompare(b.alias))
    .map(({ alias, provider, model }) => `- ${alias}: ${provider}/${model}`);
}

// Derive from the effective tools so servers whose tools were all filtered or
// denied contribute nothing.
function buildMcpServerInstructions(tools: readonly object[]) {
  const instructionsByServer = new Map<string, string>();
  for (const tool of tools) {
    const mcp = getPluginToolMeta(tool)?.mcp;
    if (mcp?.serverInstructions) {
      instructionsByServer.set(mcp.safeServerName, mcp.serverInstructions);
    }
  }
  return [...instructionsByServer]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([serverName, instructions]) => ({ serverName, instructions }));
}

/** Builds the agent system prompt after applying config-derived prompt fields. */
export function buildConfiguredAgentSystemPrompt(params: ConfiguredAgentSystemPromptParams) {
  const {
    config,
    tools,
    agentId: explicitAgentId,
    preparedModelRuntime,
    preparedTtsPreferences,
    ...renderParams
  } = params;
  const agentId = explicitAgentId ?? (tools ? params.runtimeInfo?.agentId : undefined);
  if (tools) {
    renderParams.toolNames = tools.map((tool) => tool.name);
    renderParams.messageTool = tools.find((tool) => tool.name.trim().toLowerCase() === "message");
    renderParams.mcpServerInstructions = buildMcpServerInstructions(tools);
  }
  if (!config) {
    return buildAgentSystemPrompt(renderParams);
  }
  const includeFullSections =
    renderParams.promptMode !== "minimal" && renderParams.promptMode !== "none";
  return buildAgentSystemPrompt({
    ...renderParams,
    ownerDisplay: "raw",
    ownerDisplaySecret: undefined,
    subagentDelegationMode: resolveMainSessionDelegationMode({
      config,
      agentId,
      sessionKey: renderParams.runtimeInfo?.sessionKey,
    }),
    ttsHint: includeFullSections
      ? buildTtsSystemPromptHint(config, agentId, {
          preparedTtsPreferences,
          messageToolOnly: renderParams.sourceReplyDeliveryMode === "message_tool_only",
        })
      : undefined,
    modelAliasLines: includeFullSections ? buildModelAliasLines(preparedModelRuntime) : [],
    memoryCitationsMode: config.memory?.citations,
    fsWorkspaceOnly: resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId }),
  });
}
