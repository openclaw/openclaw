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

type ConfiguredAgentSystemPromptParams = Parameters<typeof buildAgentSystemPrompt>[0] & {
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

/** Builds the agent system prompt after applying config-derived prompt fields. */
export function buildConfiguredAgentSystemPrompt(params: ConfiguredAgentSystemPromptParams) {
  const { config, agentId, preparedModelRuntime, ...renderParams } = params;
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
          messageToolOnly: renderParams.sourceReplyDeliveryMode === "message_tool_only",
        })
      : undefined,
    modelAliasLines: includeFullSections ? buildModelAliasLines(preparedModelRuntime) : [],
    memoryCitationsMode: config.memory?.citations,
    fsWorkspaceOnly: resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId }),
  });
}
