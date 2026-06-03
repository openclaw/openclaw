import { createGoogleThinkingPayloadWrapper } from "../llm/providers/stream-wrappers/google.js";
import { createMinimaxFastModeWrapper } from "../llm/providers/stream-wrappers/minimax.js";
import { resolveMoonshotThinkingKeep } from "../llm/providers/stream-wrappers/moonshot-thinking.js";
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
} from "../llm/providers/stream-wrappers/openai.js";
import {
  createKilocodeWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../llm/providers/stream-wrappers/proxy.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";
import {
  createMoonshotThinkingWrapper,
  createToolStreamWrapper,
  resolveMoonshotThinkingType,
} from "./provider-stream-shared.js";
export {
  applyAnthropicEphemeralCacheControlMarkers,
  applyAnthropicPayloadPolicyToParams,
  composeProviderStreamWrappers,
  createAnthropicThinkingPrefillPayloadWrapper,
  createMoonshotThinkingWrapper,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
  createZaiToolStreamWrapper,
  defaultToolStreamExtraParams,
  isOpenAICompatibleThinkingEnabled,
  type ProviderStreamWrapperFactory,
  resolveAnthropicPayloadPolicy,
  resolveMoonshotThinkingType,
  streamWithPayloadPatch,
  stripTrailingAnthropicAssistantPrefillWhenThinking,
} from "./provider-stream-shared.js";

export type ProviderStreamFamily =
  /** Google payload wrapper that maps OpenClaw thinking levels to Gemini thinking config. */
  | "google-thinking"
  /** Proxy wrapper for Kilocode models; unsupported auto/router models intentionally drop reasoning. */
  | "kilocode-thinking"
  /** Moonshot thinking wrapper; explicit tool_choice forces thinking off for API compatibility. */
  | "moonshot-thinking"
  /** MiniMax wrapper that rewrites eligible model ids into high-speed mode when requested. */
  | "minimax-fast-mode"
  /** OpenAI Responses wrapper stack for headers, extra params, web search, and reasoning cleanup. */
  | "openai-responses-defaults"
  /** OpenRouter proxy wrapper; model capability gaps suppress unsupported reasoning payloads. */
  | "openrouter-thinking"
  /** Tool-stream wrapper that defaults on unless the caller explicitly sends tool_stream=false. */
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
          const thinkingKeep = resolveMoonshotThinkingKeep({
            configuredThinking: ctx.extraParams?.thinking,
          });
          return createMoonshotThinkingWrapper(ctx.streamFn, thinkingType, thinkingKeep);
        },
      };
    case "kilocode-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          // Auto/proxy models that cannot advertise reasoning must see the untouched payload.
          // Sending a best-effort reasoning object there causes provider-side schema failures.
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
          // Keep context management outermost so the final payload shape already includes
          // compatibility rewrites, thinking-level normalization, and string-content cleanup.
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
          // OpenRouter accepts provider-family reasoning only for models with a known payload
          // contract. Unknown/unsupported models keep the caller payload untouched.
          const thinkingLevel =
            ctx.modelId === "auto" || isProxyReasoningUnsupported(ctx.modelId)
              ? undefined
              : ctx.thinkingLevel;
          return createOpenRouterWrapper(ctx.streamFn, thinkingLevel, ctx.extraParams);
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

/** @deprecated Google provider-owned stream hook shortcut; use local provider hooks instead. */
export const GOOGLE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("google-thinking");
/** @deprecated Kilocode provider-owned stream hook shortcut; use local provider hooks instead. */
export const KILOCODE_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("kilocode-thinking");
/** @deprecated Moonshot provider-owned stream hook shortcut; use local provider hooks instead. */
export const MOONSHOT_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("moonshot-thinking");
/** @deprecated MiniMax provider-owned stream hook shortcut; use local provider hooks instead. */
export const MINIMAX_FAST_MODE_STREAM_HOOKS = buildProviderStreamFamilyHooks("minimax-fast-mode");
/** @deprecated OpenAI provider-owned stream hook shortcut; use local provider hooks instead. */
export const OPENAI_RESPONSES_STREAM_HOOKS = buildProviderStreamFamilyHooks(
  "openai-responses-defaults",
);
/** @deprecated OpenRouter provider-owned stream hook shortcut; use local provider hooks instead. */
export const OPENROUTER_THINKING_STREAM_HOOKS =
  buildProviderStreamFamilyHooks("openrouter-thinking");
/** @deprecated Provider-owned stream hook shortcut; use local provider hooks instead. */
export const TOOL_STREAM_DEFAULT_ON_HOOKS =
  buildProviderStreamFamilyHooks("tool-stream-default-on");

// Public stream-wrapper helpers for provider plugins.

export {
  createAnthropicToolPayloadCompatibilityWrapper,
  createOpenAIAnthropicToolPayloadCompatibilityWrapper,
} from "../llm/providers/stream-wrappers/anthropic-family-tool-payload-compat.js";
export {
  createGoogleThinkingPayloadWrapper,
  sanitizeGoogleThinkingPayload,
} from "../llm/providers/stream-wrappers/google.js";
export {
  createKilocodeWrapper,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../llm/providers/stream-wrappers/proxy.js";
export { createMinimaxFastModeWrapper } from "../llm/providers/stream-wrappers/minimax.js";
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
} from "../llm/providers/stream-wrappers/openai.js";
export {
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
} from "../agents/embedded-agent-runner/openrouter-model-capabilities.js";
