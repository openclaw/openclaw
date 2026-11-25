import { resolveOpenAIResponsesPayloadPolicy } from "@openclaw/ai/internal/openai-responses-payload-policy";
import type { StreamFn } from "../agents/runtime/index.js";
import { supportsOpenAIResponsesFastMode } from "../llm/providers/openai-fast-mode.js";
import { createMinimaxFastModeWrapper } from "../llm/providers/stream-wrappers/minimax.js";
import { resolveMoonshotThinkingKeep } from "../llm/providers/stream-wrappers/moonshot-thinking.js";
import {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
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
import { streamSimple } from "../llm/stream.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderWrapStreamFnContext } from "./plugin-entry.js";
import {
  createGoogleThinkingPayloadWrapper,
  createPayloadPatchStreamWrapper,
  createMoonshotThinkingWrapper,
  createToolStreamWrapper,
  resolveMoonshotThinkingType,
  streamWithPayloadPatch,
} from "./provider-stream-shared.js";
import { asOptionalObjectRecord, filterStringEntries } from "./string-coerce-runtime.js";
export {
  applyAnthropicEphemeralCacheControlMarkers,
  composeProviderStreamWrappers,
  createAnthropicThinkingPrefillPayloadWrapper,
  createMoonshotThinkingWrapper,
  createPlainTextToolCallCompatWrapper,
  createToolStreamWrapper,
  type ProviderStreamWrapperFactory,
  streamWithPayloadPatch,
} from "./provider-stream-shared.js";

/** Named stream-wrapper bundles that provider plugins can opt into without duplicating policy. */
export type ProviderStreamFamily =
  /** Requests opaque xAI reasoning while respecting the route's effort controls. */
  | "xai-responses-reasoning"
  /** Applies the native Cohere Compatibility API instruction and tool-choice policy. */
  | "cohere-compatibility"
  /** Applies Google thinking-level payload normalization. */
  | "google-thinking"
  /** Applies Kilocode proxy reasoning payload normalization. */
  | "kilocode-thinking"
  /** Applies Moonshot thinking type/keep normalization. */
  | "moonshot-thinking"
  /** Enables MiniMax high-speed model routing when requested. */
  | "minimax-fast-mode"
  /** Applies the default OpenAI Responses wrapper stack. */
  | "openai-responses-defaults"
  /** Applies tier preferences to provider-qualified OpenAI Responses proxy routes. */
  | "openai-responses-service-tier"
  /** Applies OpenRouter proxy reasoning payload normalization. */
  | "openrouter-thinking"
  /** Enables tool-call event streaming unless explicitly disabled. */
  | "tool-stream-default-on";

type ProviderStreamFamilyHooks = Pick<ProviderPlugin, "wrapStreamFn">;

function hasFastModeParam(extraParams: Record<string, unknown> | undefined): boolean {
  return Boolean(
    extraParams &&
    (Object.hasOwn(extraParams, "fastMode") || Object.hasOwn(extraParams, "fast_mode")),
  );
}

function resolveBooleanFastMode(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  const raw = extraParams?.fastMode ?? extraParams?.fast_mode;
  const resolved = typeof raw === "function" ? (raw as () => unknown)() : raw;
  return resolved === "ultrafast" ? true : typeof resolved === "boolean" ? resolved : undefined;
}

function createResponsesServiceTierStream(
  ctx: ProviderWrapStreamFnContext,
  routed = false,
): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  const serviceTier = resolveOpenAIServiceTier(ctx.extraParams);
  if (!serviceTier && !hasFastModeParam(ctx.extraParams)) {
    return underlying;
  }
  return (model, context, options) => {
    // Snapshot timed Auto once per request, including async replacement payloads.
    const fastMode = resolveOpenAIFastMode(ctx.extraParams);
    const tier = fastMode
      ? fastMode === "ultrafast"
        ? "ultrafast"
        : "priority"
      : fastMode === false && serviceTier
        ? "default"
        : serviceTier;
    // Proxies opt in only after qualifying their upstream route. Native callers
    // retain their existing endpoint and Fast eligibility policy.
    const eligible = routed
      ? model.api === "openai-responses"
      : resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" }).allowsServiceTier &&
        (!fastMode || supportsOpenAIResponsesFastMode(model));
    if (!tier || !eligible) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      if (payload.service_tier === undefined) {
        payload.service_tier = tier;
      }
    });
  };
}

/** Builds provider hook objects for one supported stream-wrapper family. */
export function buildProviderStreamFamilyHooks(
  /**
   * Family key selecting the exact wrapper bundle to attach to a provider.
   */
  family: ProviderStreamFamily,
): ProviderStreamFamilyHooks {
  switch (family) {
    case "xai-responses-reasoning":
      return {
        wrapStreamFn: (ctx) =>
          createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
            if (
              !model.reasoning ||
              asOptionalObjectRecord(model.compat)?.supportsReasoningEffort === false
            ) {
              delete payload.reasoning;
              delete payload.reasoningEffort;
              delete payload.reasoning_effort;
            }
            if (model.api !== "openai-responses" || !model.reasoning) {
              return;
            }
            const include = filterStringEntries(payload.include);
            if (!include.includes("reasoning.encrypted_content")) {
              include.push("reasoning.encrypted_content");
            }
            payload.include = include;
          }),
      };
    case "cohere-compatibility":
      return {
        wrapStreamFn: (ctx) =>
          createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload }) => {
            if (Array.isArray(payload.messages)) {
              payload.messages = payload.messages.map((message) => {
                const record = asOptionalObjectRecord(message);
                return record?.role === "system" ? { ...record, role: "developer" } : message;
              });
            }
            // Cohere chooses tools when omitted; its Compatibility API does not accept tool_choice.
            delete payload.tool_choice;
            // Native catalog rows already declare these fields. Apply the same wire contract
            // to credential-scoped routing catalogs without borrowing another route's facts.
            if (payload.max_tokens === undefined && payload.max_completion_tokens !== undefined) {
              payload.max_tokens = payload.max_completion_tokens;
            }
            delete payload.max_completion_tokens;
            delete payload.store;
            delete payload.stream_options;
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
            ctx.modelId === "kilo-auto/balanced" || isProxyReasoningUnsupported(ctx.modelId)
              ? undefined
              : ctx.thinkingLevel;
          return createKilocodeWrapper(ctx.streamFn, thinkingLevel);
        },
      };
    case "minimax-fast-mode":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createMinimaxFastModeWrapper(ctx.streamFn, () => resolveBooleanFastMode(ctx.extraParams)),
      };
    case "openai-responses-defaults":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          // Wrapper order is observable: header/default params must be in place
          // before payload-shape and context-management compatibility rewrites.
          let nextStreamFn = createOpenAIAttributionHeadersWrapper(ctx.streamFn);

          nextStreamFn = createResponsesServiceTierStream({ ...ctx, streamFn: nextStreamFn });

          const textVerbosity = resolveOpenAITextVerbosity(ctx.extraParams);
          if (textVerbosity) {
            nextStreamFn = createOpenAITextVerbosityWrapper(nextStreamFn, textVerbosity);
          }

          nextStreamFn = createCodexNativeWebSearchWrapper(nextStreamFn, {
            config: ctx.config,
            agentDir: ctx.agentDir,
            agentId: ctx.agentId,
            nativeWebSearchAllowedByToolPolicy: ctx.nativeWebSearchAllowedByToolPolicy,
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
    case "openai-responses-service-tier":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) =>
          createResponsesServiceTierStream(ctx, true),
      };
    case "openrouter-thinking":
      return {
        wrapStreamFn: (ctx: ProviderWrapStreamFnContext) => {
          const thinkingLevel = ctx.modelId === "auto" ? undefined : ctx.thinkingLevel;
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

/** @deprecated Moonshot provider-owned stream hook shortcut; use local provider hooks instead. */
export const MOONSHOT_THINKING_STREAM_HOOKS = buildProviderStreamFamilyHooks("moonshot-thinking");

export {
  createAnthropicToolPayloadCompatibilityWrapper,
  createOpenAIAnthropicToolPayloadCompatibilityWrapper,
} from "../llm/providers/stream-wrappers/anthropic-family-tool-payload-compat.js";
export { sanitizeGoogleThinkingPayload } from "../llm/providers/stream-wrappers/google-thinking-payload.js";
export {
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "../llm/providers/stream-wrappers/proxy.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { createOpenRouterSystemCacheWrapper } from "../llm/providers/stream-wrappers/proxy.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { resolveMoonshotThinkingType } from "./provider-stream-shared.js";
export { createMinimaxFastModeWrapper } from "../llm/providers/stream-wrappers/minimax.js";
export {
  createOpenAIAttributionHeadersWrapper,
  createCodexNativeWebSearchWrapper,
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
