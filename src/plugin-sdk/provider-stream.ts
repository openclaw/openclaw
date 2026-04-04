import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";
import {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
} from "../agents/pi-embedded-runner/google-stream-wrappers.js";
import { createMinimaxFastModeWrapper } from "../agents/pi-embedded-runner/minimax-stream-wrappers.js";
import {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
} from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
import {
  createKilocodeWrapper,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../agents/pi-embedded-runner/proxy-stream-wrappers.js";
import { createToolStreamWrapper, createZaiToolStreamWrapper } from "../agents/pi-embedded-runner/zai-stream-wrappers.js";

export type ProviderStreamWrapperFactory =
  | ((streamFn: StreamFn | undefined) => StreamFn | undefined)
  | null
  | undefined
  | false;

export function composeProviderStreamWrappers(
  baseStreamFn: StreamFn | undefined,
  ...wrappers: ProviderStreamWrapperFactory[]
): StreamFn | undefined {
  return wrappers.reduce<StreamFn | undefined>(
    (streamFn, wrapper) => (wrapper ? wrapper(streamFn) : streamFn),
    baseStreamFn,
  );
}

export type ProviderStreamFamily =
  | "google-thinking"
  | "moonshot-thinking"
  | "minimax-fast-mode"
  | "tool-stream-default-on";

type ProviderStreamFamilyHooks = Pick<ProviderPlugin, "wrapStreamFn">;

export function buildProviderStreamFamilyHooks(
  family: ProviderStreamFamily,
): ProviderStreamFamilyHooks {
  switch (family) {
    case "google-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel),
      };
    case "moonshot-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          const thinkingType = resolveMoonshotThinkingType({
            configuredThinking: ctx.extraParams?.thinking,
            thinkingLevel: ctx.thinkingLevel,
          });
          return createMoonshotThinkingWrapper(ctx.streamFn, thinkingType);
        },
      };
    case "minimax-fast-mode":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createMinimaxFastModeWrapper(ctx.streamFn, ctx.extraParams?.fastMode === true),
      };
    case "tool-stream-default-on":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createToolStreamWrapper(ctx.streamFn, ctx.extraParams?.tool_stream !== false),
      };
  }
}

// Public stream-wrapper helpers for provider plugins.

export {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "../agents/anthropic-payload-policy.js";
export {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "../agents/copilot-dynamic-headers.js";
export { applyAnthropicEphemeralCacheControlMarkers } from "../agents/pi-embedded-runner/anthropic-cache-control-payload.js";
export {
  createAnthropicToolPayloadCompatibilityWrapper,
  createOpenAIAnthropicToolPayloadCompatibilityWrapper,
} from "../agents/pi-embedded-runner/anthropic-family-tool-payload-compat.js";
export {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "../agents/pi-embedded-runner/bedrock-stream-wrappers.js";
export {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
  createMinimaxFastModeWrapper,
  createKilocodeWrapper,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingType,
};
export {
  createOpenAIAttributionHeadersWrapper,
  createCodexNativeWebSearchWrapper,
  createOpenAIDefaultTransportWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAITextVerbosityWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
  resolveOpenAITextVerbosity,
} from "../agents/pi-embedded-runner/openai-stream-wrappers.js";
export { streamWithPayloadPatch } from "../agents/pi-embedded-runner/stream-payload-utils.js";
export { createToolStreamWrapper, createZaiToolStreamWrapper };
export {
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "../agents/pi-embedded-runner/openrouter-model-capabilities.js";
