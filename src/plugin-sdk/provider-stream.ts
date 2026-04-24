import {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
} from "../agents/pi-embedded-runner/google-stream-wrappers.js";
import { createMinimaxFastModeWrapper } from "../agents/pi-embedded-runner/minimax-stream-wrappers.js";
import { resolveMoonshotThinkingKeep } from "../agents/pi-embedded-runner/moonshot-thinking-stream-wrappers.js";
import {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAIStringContentWrapper,
  createOpenAITextVerbosityWrapper,
  createOpenAIThinkingLevelWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
  resolveOpenAITextVerbosity,
} from "../agents/pi-embedded-runner/openai-stream-wrappers.js";
import {
  createKilocodeWrapper,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../agents/pi-embedded-runner/proxy-stream-wrappers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";
import {
  createMoonshotThinkingWrapper,
  createPayloadPatchStreamWrapper,
  createToolStreamWrapper,
  resolveMoonshotThinkingType,
} from "./provider-stream-shared.js";
export {
  applyAnthropicEphemeralCacheControlMarkers,
  applyAnthropicPayloadPolicyToParams,
  buildCopilotDynamicHeaders,
  composeProviderStreamWrappers,
  createBedrockNoCacheWrapper,
  createMoonshotThinkingWrapper,
  createToolStreamWrapper,
  createZaiToolStreamWrapper,
  defaultToolStreamExtraParams,
  hasCopilotVisionInput,
  isAnthropicBedrockModel,
  type ProviderStreamWrapperFactory,
  resolveAnthropicPayloadPolicy,
  resolveMoonshotThinkingType,
  streamWithPayloadPatch,
} from "./provider-stream-shared.js";

type DeepSeekThinkingType = "enabled" | "disabled";
const DEEPSEEK_V4_MODEL_IDS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

function isDeepSeekV4ModelId(modelId: string | undefined): boolean {
  return modelId ? DEEPSEEK_V4_MODEL_IDS.has(modelId.trim().toLowerCase()) : false;
}

function normalizeDeepSeekThinkingType(value: unknown): DeepSeekThinkingType | undefined {
  if (typeof value === "boolean") {
    return value ? "enabled" : "disabled";
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["enabled", "enable", "on", "true"].includes(normalized)) {
      return "enabled";
    }
    if (["disabled", "disable", "off", "false"].includes(normalized)) {
      return "disabled";
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeDeepSeekThinkingType((value as Record<string, unknown>).type);
  }
  return undefined;
}

function resolveDeepSeekThinkingType(params: {
  configuredThinking: unknown;
  modelId?: string;
  thinkingLevel?: string;
}): DeepSeekThinkingType | undefined {
  if (params.modelId === "deepseek-reasoner") {
    return "enabled";
  }
  if (!isDeepSeekV4ModelId(params.modelId)) {
    return undefined;
  }
  const configured = normalizeDeepSeekThinkingType(params.configuredThinking);
  if (configured) {
    return configured;
  }
  if (!params.thinkingLevel) {
    return undefined;
  }
  return params.thinkingLevel === "off" ? "disabled" : "enabled";
}

export type ProviderStreamFamily =
  | "deepseek-thinking"
  | "google-thinking"
  | "kilocode-thinking"
  | "moonshot-thinking"
  | "minimax-fast-mode"
  | "openai-responses-defaults"
  | "openrouter-thinking"
  | "tool-stream-default-on";

type ProviderStreamFamilyHooks = Pick<ProviderPlugin, "wrapStreamFn">;

export function buildProviderStreamFamilyHooks(
  family: ProviderStreamFamily,
): ProviderStreamFamilyHooks {
  switch (family) {
    case "deepseek-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
            const modelId = ctx.modelId ?? model.id;
            if (modelId === "deepseek-chat") {
              delete payload.thinking;
              return;
            }
            const thinkingType = resolveDeepSeekThinkingType({
              configuredThinking: ctx.extraParams?.thinking,
              modelId,
              thinkingLevel: ctx.thinkingLevel,
            });
            if (thinkingType) {
              payload.thinking = { type: thinkingType };
            }
          }),
      };
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
          const thinkingKeep = resolveMoonshotThinkingKeep({
            configuredThinking: ctx.extraParams?.thinking,
          });
          return createMoonshotThinkingWrapper(ctx.streamFn, thinkingType, thinkingKeep);
        },
      };
    case "kilocode-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          const thinkingLevel =
            ctx.modelId === "kilo/auto" || isProxyReasoningUnsupported(ctx.modelId)
              ? undefined
              : ctx.thinkingLevel;
          return createKilocodeWrapper(ctx.streamFn, thinkingLevel);
        },
      };
    case "minimax-fast-mode":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createMinimaxFastModeWrapper(ctx.streamFn, ctx.extraParams?.fastMode === true),
      };
    case "openai-responses-defaults":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          let nextStreamFn = createOpenAIAttributionHeadersWrapper(ctx.streamFn);

          if (resolveOpenAIFastMode(ctx.extraParams)) {
            nextStreamFn = createOpenAIFastModeWrapper(nextStreamFn);
          }

          const serviceTier = resolveOpenAIServiceTier(ctx.extraParams);
          if (serviceTier) {
            nextStreamFn = createOpenAIServiceTierWrapper(nextStreamFn, serviceTier);
          }

          const textVerbosity = resolveOpenAITextVerbosity(ctx.extraParams);
          if (textVerbosity) {
            nextStreamFn = createOpenAITextVerbosityWrapper(nextStreamFn, textVerbosity);
          }

          nextStreamFn = createCodexNativeWebSearchWrapper(nextStreamFn, {
            config: ctx.config,
            agentDir: ctx.agentDir,
          });
          nextStreamFn = createOpenAIStringContentWrapper(nextStreamFn);
          return createOpenAIResponsesContextManagementWrapper(
            createOpenAIReasoningCompatibilityWrapper(
              createOpenAIThinkingLevelWrapper(nextStreamFn, ctx.thinkingLevel),
            ),
            ctx.extraParams,
          );
        },
      };
    case "openrouter-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          const thinkingLevel =
            ctx.modelId === "auto" || isProxyReasoningUnsupported(ctx.modelId)
              ? undefined
              : ctx.thinkingLevel;
          return createOpenRouterWrapper(ctx.streamFn, thinkingLevel);
        },
      };
    case "tool-stream-default-on":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createToolStreamWrapper(ctx.streamFn, ctx.extraParams?.tool_stream !== false),
      };
  }
  throw new Error("Unsupported provider stream family");
}

export const DEEPSEEK_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("deepseek-thinking");
export const GOOGLE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("google-thinking");
export const KILOCODE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("kilocode-thinking");
export const MOONSHOT_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("moonshot-thinking");
export const MINIMAX_FAST_MODE_STREAM_HOOKS = buildProviderStreamFamilyHooks("minimax-fast-mode");
export const OPENAI_RESPONSES_STREAM_HOOKS = buildProviderStreamFamilyHooks(
  "openai-responses-defaults",
);
export const OPENROUTER_THINKING_STREAM_HOOKS =
  buildProviderStreamFamilyHooks("openrouter-thinking");
export const TOOL_STREAM_DEFAULT_ON_HOOKS =
  buildProviderStreamFamilyHooks("tool-stream-default-on");

// Public stream-wrapper helpers for provider plugins.

export {
  createAnthropicToolPayloadCompatibilityWrapper,
  createOpenAIAnthropicToolPayloadCompatibilityWrapper,
} from "../agents/pi-embedded-runner/anthropic-family-tool-payload-compat.js";
export {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
} from "../agents/pi-embedded-runner/google-stream-wrappers.js";
export {
  createKilocodeWrapper,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../agents/pi-embedded-runner/proxy-stream-wrappers.js";
export { createMinimaxFastModeWrapper } from "../agents/pi-embedded-runner/minimax-stream-wrappers.js";
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
export {
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "../agents/pi-embedded-runner/openrouter-model-capabilities.js";
