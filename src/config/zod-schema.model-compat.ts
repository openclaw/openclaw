// Model compat schema fragment: provider capability flags for payload shaping and feature gating.
import { z } from "zod";
import type { OpenRouterRouting, VercelGatewayRouting } from "../llm/types.js";
import { MODEL_THINKING_FORMATS } from "./model-config-vocabulary.js";

const RoutingPercentileCutoffsSchema = z
  .object({
    p50: z.number().optional(),
    p75: z.number().optional(),
    p90: z.number().optional(),
    p99: z.number().optional(),
  })
  .strict();

const OpenRouterRoutingSchema = z
  .object({
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(["deny", "allow"]).optional(),
    zdr: z.boolean().optional(),
    enforce_distillable_text: z.boolean().optional(),
    order: z.array(z.string()).optional(),
    only: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    quantizations: z.array(z.string()).optional(),
    sort: z
      .union([
        z.string(),
        z
          .object({
            by: z.string().optional(),
            partition: z.string().nullable().optional(),
          })
          .strict(),
      ])
      .optional(),
    max_price: z
      .object({
        prompt: z.union([z.number(), z.string()]).optional(),
        completion: z.union([z.number(), z.string()]).optional(),
        image: z.union([z.number(), z.string()]).optional(),
        audio: z.union([z.number(), z.string()]).optional(),
        request: z.union([z.number(), z.string()]).optional(),
      })
      .strict()
      .optional(),
    preferred_min_throughput: z.union([z.number(), RoutingPercentileCutoffsSchema]).optional(),
    preferred_max_latency: z.union([z.number(), RoutingPercentileCutoffsSchema]).optional(),
  } satisfies Record<keyof OpenRouterRouting, z.ZodType>)
  .strict();

const VercelGatewayRoutingSchema = z
  .object({
    only: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
  } satisfies Record<keyof VercelGatewayRouting, z.ZodType>)
  .strict();

export const ModelCompatSchema = z
  .object({
    /** Whether the provider supports the `store` field. Default: auto-detected from URL. */
    supportsStore: z.boolean().optional(),
    /** Whether provider accepts prompt-cache/session affinity keys. */
    supportsPromptCacheKey: z.boolean().optional(),
    /** Opts this model into stored HTTP continuation on a verified compatible endpoint. */
    supportsResponsesContinuation: z.boolean().optional(),
    /** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
    supportsDeveloperRole: z.boolean().optional(),
    /** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
    supportsReasoningEffort: z.boolean().optional(),
    /** Whether the model accepts the `temperature` parameter. Default: true. */
    supportsTemperature: z.boolean().optional(),
    /**
     * Whether the provider honors top-level `instructions`. Defaults to true only for verified
     * native routes (OpenAI, xAI); every other route defaults to false and embeds the system
     * prompt in `input` unless set true here after verifying against that endpoint.
     */
    supportsInstructions: z.boolean().optional(),
    /**
     * Whether the provider supports `stream_options: { include_usage: true }` for token usage in
     * streaming responses. Default: true.
     */
    supportsUsageInStreaming: z.boolean().optional(),
    /** Whether this model supports tool/function calling. */
    supportsTools: z.boolean().optional(),
    /** Code-mode tier consumed by `tools.codeMode.enabled: "auto"`; absent means "capable". */
    codeMode: z.enum(["preferred", "capable"]).optional(),
    /** Whether the provider supports the `strict` field in tool definitions. Default: true. */
    supportsStrictMode: z.boolean().optional(),
    /**
     * Whether the provider supports JSON Schema through `response_format`. Default: false for
     * unknown compatible endpoints.
     */
    supportsJsonSchemaResponseFormat: z.boolean().optional(),
    /** Whether all message parts must be coerced to plain strings. */
    requiresStringContent: z.boolean().optional(),
    /** Whether unknown message payload keys must be stripped before requests. */
    strictMessageKeys: z.boolean().optional(),
    /** Reasoning detail block types safe to expose in visible transcripts. */
    visibleReasoningDetailTypes: z.array(z.string().min(1)).optional(),
    /** Provider-accepted reasoning effort labels. */
    supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
    /** Per-level reasoning effort overrides, e.g. map "off" to "low" for models that cannot disable thinking. */
    reasoningEffortMap: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** Which field to use for max tokens. Default: auto-detected from URL. */
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
    /** Reasoning/thinking payload dialect for provider-compatible APIs. */
    thinkingFormat: z.enum(MODEL_THINKING_FORMATS).optional(),
    /** Whether tool results require the `name` field. Default: auto-detected from URL. */
    requiresToolResultName: z.boolean().optional(),
    /**
     * Whether a user message after tool results requires an assistant message in between. Default:
     * auto-detected from URL.
     */
    requiresAssistantAfterToolResult: z.boolean().optional(),
    /**
     * Whether thinking blocks must be converted to text blocks with <thinking> delimiters.
     * Default: auto-detected from URL.
     */
    requiresThinkingAsText: z.boolean().optional(),
    /**
     * Whether all replayed assistant messages must include an empty reasoning_content field when
     * reasoning is enabled. Default: auto-detected from URL.
     */
    requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
    /** Named tool-schema profile used by provider adapters. */
    toolSchemaProfile: z.string().optional(),
    /** JSON Schema keywords rejected by this provider's tool schema validator. */
    unsupportedToolSchemaKeywords: z.array(z.string().min(1)).optional(),
    /** Encoding expected for tool-call arguments in provider payloads. */
    toolCallArgumentsEncoding: z.string().optional(),
    /** Whether OpenAI-style calls must be reshaped to Anthropic-compatible tool payloads. */
    requiresOpenAiAnthropicToolPayload: z.boolean().optional(),
    /** OpenRouter-specific routing preferences. Only used when baseUrl points to OpenRouter. */
    openRouterRouting: OpenRouterRoutingSchema.optional(),
    /** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
    vercelGatewayRouting: VercelGatewayRoutingSchema.optional(),
    /** Whether z.ai supports top-level `tool_stream: true` for streaming tool call deltas. Default: false. */
    zaiToolStream: z.boolean().optional(),
    /**
     * Cache control convention for prompt caching. "anthropic" applies Anthropic-style
     * `cache_control` markers to the system prompt, last tool definition, and last user/assistant
     * text content.
     */
    cacheControlFormat: z.literal("anthropic").optional(),
    /**
     * Whether to send known session-affinity headers (`session_id`, `x-client-request-id`,
     * `x-session-affinity`) from `options.sessionId` when caching is enabled. Default: false.
     */
    sendSessionAffinityHeaders: z.boolean().optional(),
    /**
     * Whether to send the OpenAI `session_id` cache-affinity header from `options.sessionId` when
     * caching is enabled. Default: true.
     */
    sendSessionIdHeader: z.boolean().optional(),
    /**
     * Whether the provider accepts per-tool `eager_input_streaming`. When false, the Anthropic
     * provider omits `tools[].eager_input_streaming` and sends the legacy
     * `fine-grained-tool-streaming-2025-05-14` beta header for tool-enabled requests. Default:
     * true.
     */
    supportsEagerToolInputStreaming: z.boolean().optional(),
    /**
     * Whether the provider supports long prompt cache retention (`prompt_cache_retention: "24h"`
     * or Anthropic-style `cache_control.ttl: "1h"`, depending on format). Default: true. Whether
     * the provider supports `prompt_cache_retention: "24h"`. Default: true. Whether the provider
     * supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true.
     */
    supportsLongCacheRetention: z.boolean().optional(),
    /**
     * Drops cumulative text-delta replays: provider frames whose single `text_delta` equals all
     * text accumulated so far (a full-content replay, not an increment), which naive accumulation
     * would double into the live message. Default: false (stock provider behavior is preserved).
     */
    dropCumulativeTextDeltaReplays: z.boolean().optional(),
  })
  .strict()
  .optional();
