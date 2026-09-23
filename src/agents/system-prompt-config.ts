/**
 * Config-aware system prompt builder.
 *
 * This module gathers agent/config knobs before rendering the canonical system
 * prompt so callers do not duplicate owner, TTS, alias, memory, or FS policy.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildTtsSystemPromptHint } from "../tts/tts-settings.js";
import { resolveMainSessionDelegationMode } from "./delegation-guidance.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "./tool-fs-policy.js";

type AgentSystemPromptRenderParams = Parameters<typeof buildAgentSystemPrompt>[0];

/** Config-derived system prompt fields passed into the prompt renderer. */
type ResolvedAgentSystemPromptConfig = Pick<
  AgentSystemPromptRenderParams,
  | "ownerDisplay"
  | "ownerDisplaySecret"
  | "subagentDelegationMode"
  | "ttsHint"
  | "modelAliasLines"
  | "memoryCitationsMode"
  | "fsWorkspaceOnly"
>;

type ConfiguredAgentSystemPromptParams = AgentSystemPromptRenderParams & {
  config?: OpenClawConfig;
  agentId?: string;
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

/** Resolves all config-derived system prompt fields for an agent. */
function resolveAgentSystemPromptConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  promptMode?: AgentSystemPromptRenderParams["promptMode"];
  sourceReplyDeliveryMode?: AgentSystemPromptRenderParams["sourceReplyDeliveryMode"];
  preparedModelRuntime?: ConfiguredAgentSystemPromptParams["preparedModelRuntime"];
}): ResolvedAgentSystemPromptConfig {
  const { config, agentId, sessionKey, sourceReplyDeliveryMode } = params;
  const includeFullSections = params.promptMode !== "minimal" && params.promptMode !== "none";
  return {
    ownerDisplay: "raw",
    ownerDisplaySecret: undefined,
    subagentDelegationMode: resolveMainSessionDelegationMode({ config, agentId, sessionKey }),
    ttsHint:
      config && includeFullSections
        ? buildTtsSystemPromptHint(config, agentId, {
            messageToolOnly: sourceReplyDeliveryMode === "message_tool_only",
          })
        : undefined,
    modelAliasLines: includeFullSections ? buildModelAliasLines(params.preparedModelRuntime) : [],
    memoryCitationsMode: config?.memory?.citations,
    fsWorkspaceOnly: resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId }),
  };
}

/** Builds the agent system prompt after applying config-derived prompt fields. */
export function buildConfiguredAgentSystemPrompt(params: ConfiguredAgentSystemPromptParams) {
  const { config, agentId, preparedModelRuntime, ...renderParams } = params;
  const configParams = config
    ? resolveAgentSystemPromptConfig({
        config,
        agentId,
        preparedModelRuntime,
        sessionKey: renderParams.runtimeInfo?.sessionKey,
        promptMode: renderParams.promptMode,
        sourceReplyDeliveryMode: renderParams.sourceReplyDeliveryMode,
      })
    : {};
  return buildAgentSystemPrompt({
    ...renderParams,
    ...configParams,
  });
}
