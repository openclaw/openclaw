// Defines core Zod schema fragments for canonical config parsing.
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import type { OpenRouterRouting, VercelGatewayRouting } from "../llm/types.js";
import { normalizeExactAllowedHost } from "../secrets/exact-hostname.js";
import { ENV_SECRET_REF_ID_RE, SECRET_PROVIDER_ALIAS_PATTERN } from "../secrets/ref-contract.js";
import { MODEL_APIS, MODEL_THINKING_FORMATS } from "./model-config-vocabulary.js";
import { isBuiltInModelProviderOverlayId } from "./model-provider-overlay-ids.js";
import { createAllowDenyChannelRulesSchema } from "./zod-schema.allowdeny.js";
import { DmConfigSchema } from "./zod-schema.messages.js";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { sensitive } from "./zod-schema.sensitive.js";

export {
  DmConfigSchema,
  GroupChatSchema,
  MentionPatternsPolicySchema,
  ProviderCommandsSchema,
} from "./zod-schema.messages.js";
export { SecretInputSchema, SecretRefSchema } from "./zod-schema.secret-input.js";

const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePath(value: string): boolean {
  // `path.isAbsolute` follows the host OS, but config files can be authored for Windows from
  // macOS/Linux. Accept Windows forms explicitly so cross-platform config validation stays stable.
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

/** Canonical operator-configurable SSRF policy shared by network-capable surfaces. */
export const SsrFPolicyConfigSchema = z
  .object({
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
    allowRfc2544BenchmarkRange: z.boolean().optional(),
    allowIpv6UniqueLocalRange: z.boolean().optional(),
    allowedHostnames: z.array(z.string()).optional(),
    blockedHostnames: z.array(z.string()).optional(),
  })
  .strict();

const SecretsEnvProviderSchema = z
  .object({
    source: z.literal("env"),
    /** Optional env var allowlist (exact names). */
    allowlist: z.array(z.string().regex(ENV_SECRET_REF_ID_RE)).max(256).optional(),
  })
  .strict();

const SecretsFileProviderSchema = z
  .object({
    source: z.literal("file"),
    path: z.string().min(1),
    mode: z.union([z.literal("singleValue"), z.literal("json")]).optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .optional(),
  })
  .strict();

const SecretsManualExecProviderSchema = z
  .object({
    source: z.literal("exec"),
    command: z
      .string()
      .min(1)
      .refine((value) => isSafeExecutableValue(value), "secrets.providers.*.command is unsafe.")
      .refine(
        (value) => isAbsolutePath(value),
        "secrets.providers.*.command must be an absolute path.",
      ),
    args: z.array(z.string().max(1024)).max(128).optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
    noOutputTimeoutMs: z.number().int().positive().max(120000).optional(),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .optional(),
    jsonOnly: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    passEnv: z.array(z.string().regex(ENV_SECRET_REF_ID_RE)).max(128).optional(),
    trustedDirs: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => isAbsolutePath(value), "trustedDirs entries must be absolute paths."),
      )
      .max(64)
      .optional(),
  })
  .strict();

const SecretsPluginIntegrationExecProviderSchema = z
  .object({
    source: z.literal("exec"),
    pluginIntegration: z
      .object({
        pluginId: z.string().min(1).max(128),
        integrationId: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

const SecretsExecProviderSchema = z.union([
  SecretsManualExecProviderSchema,
  SecretsPluginIntegrationExecProviderSchema,
]);

const SecretsStoreProviderSchema = z.object({ source: z.literal("store") }).strict();

// Same exact-host contract as per-secret destination bindings: rejecting schemes,
// ports, wildcards, and malformed hostnames here keeps invalid entries out of the
// egress-proxy startup path, which would otherwise throw while starting the Gateway.
const EgressProxyExactHostSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((host, ctx) => {
    try {
      normalizeExactAllowedHost(host);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid allowed host",
      });
    }
  });

/** Schema for one configured env/file/exec/store secret provider entry. */
export const SecretProviderSchema = z.union([
  SecretsEnvProviderSchema,
  SecretsFileProviderSchema,
  SecretsExecProviderSchema,
  SecretsStoreProviderSchema,
]);

/** Schema for the top-level `secrets` config block. */
export const SecretsConfigSchema = z
  .object({
    egressProxy: z
      .object({
        enabled: z.boolean().optional(),
        allowedHosts: z.array(EgressProxyExactHostSchema).max(256).optional(),
        bypassHosts: z.array(EgressProxyExactHostSchema).max(256).optional(),
      })
      .strict()
      .optional(),
    providers: z
      .object({
        // Keep this as a record so users can define multiple named providers per source.
      })
      .catchall(SecretProviderSchema)
      .optional(),
    defaults: z
      .object({
        env: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        file: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        exec: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        store: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const LEGACY_OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const OPENAI_CHATGPT_RESPONSES_API =
  "openai-chatgpt-responses" satisfies (typeof MODEL_APIS)[number];

const ModelApiSchema = z.enum(MODEL_APIS, {
  error: (issue) =>
    issue.input === LEGACY_OPENAI_CODEX_RESPONSES_API
      ? `"${LEGACY_OPENAI_CODEX_RESPONSES_API}" is a removed api id; use "${OPENAI_CHATGPT_RESPONSES_API}"`
      : undefined,
});

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

const ModelCompatSchema = z
  .object({
    /** Whether the provider supports the `store` field. Default: auto-detected from URL. */
    supportsStore: z.boolean().optional(),
    /** Whether provider accepts prompt-cache/session affinity keys. */
    supportsPromptCacheKey: z.boolean().optional(),
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
    dropCumulativeTextDeltaReplays: z.boolean().optional(),
  })
  .strict()
  .optional();

const ConfiguredProviderRequestTlsSchema = z
  .object({
    ca: SecretInputSchema.optional().register(sensitive),
    cert: SecretInputSchema.optional().register(sensitive),
    key: SecretInputSchema.optional().register(sensitive),
    passphrase: SecretInputSchema.optional().register(sensitive),
    serverName: z.string().optional(),
    insecureSkipVerify: z.boolean().optional(),
  })
  .strict()
  .optional();

const ConfiguredProviderRequestAuthSchema = z
  .union([
    z
      .object({
        mode: z.literal("provider-default"),
      })
      .strict(),
    z
      .object({
        mode: z.literal("authorization-bearer"),
        token: SecretInputSchema.register(sensitive),
      })
      .strict(),
    z
      .object({
        mode: z.literal("header"),
        headerName: z.string().min(1),
        value: SecretInputSchema.register(sensitive),
        prefix: z.string().optional(),
      })
      .strict(),
  ])
  .optional();

const ConfiguredProviderRequestProxySchema = z
  .union([
    z
      .object({
        mode: z.literal("env-proxy"),
        tls: ConfiguredProviderRequestTlsSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal("explicit-proxy"),
        url: z.string().min(1),
        tls: ConfiguredProviderRequestTlsSchema,
      })
      .strict(),
  ])
  .optional();

const ConfiguredProviderRequestFields = {
  headers: z.record(z.string(), SecretInputSchema.register(sensitive)).optional(),
  auth: ConfiguredProviderRequestAuthSchema,
  proxy: ConfiguredProviderRequestProxySchema,
  tls: ConfiguredProviderRequestTlsSchema,
};

const ConfiguredProviderRequestSchema = z
  .object(ConfiguredProviderRequestFields)
  .strict()
  .optional();

const ConfiguredModelProviderRequestSchema = z
  .object({
    ...ConfiguredProviderRequestFields,
    allowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const ModelAgentRuntimePolicySchema = z
  .object({
    id: z.string().optional(),
  })
  .strict()
  .optional();

const ModelImageInputSchema = z
  .object({
    maxBytes: z.number().int().positive().optional(),
    maxPixels: z.number().int().positive().optional(),
    maxSidePx: z.number().int().positive().optional(),
    preferredSidePx: z.number().int().positive().optional(),
    tokenMode: z.union([z.literal("tile"), z.literal("detail"), z.literal("provider")]).optional(),
  })
  .strict();

const ModelMediaInputSchema = z
  .object({
    image: ModelImageInputSchema.optional(),
  })
  .strict();

// Mirrors the runtime ThinkingLevelMap contract (model-registry TypeBox schema). Persisted model
// entries carry thinkingLevelMap, so the strict config schema must accept it or updateConfig rolls back.
const ThinkingLevelMapValueSchema = z.string().nullable();
const ThinkingLevelMapSchema = z
  .object({
    off: ThinkingLevelMapValueSchema.optional(),
    minimal: ThinkingLevelMapValueSchema.optional(),
    low: ThinkingLevelMapValueSchema.optional(),
    medium: ThinkingLevelMapValueSchema.optional(),
    high: ThinkingLevelMapValueSchema.optional(),
    xhigh: ThinkingLevelMapValueSchema.optional(),
    max: ThinkingLevelMapValueSchema.optional(),
  })
  .strict();

const ModelDefinitionSchema = z
  .object({
    /** Provider-facing model id. */
    id: z.string().min(1),
    /** Human-readable display name. */
    name: z.string().min(1),
    /** Optional API adapter override for this model. */
    api: ModelApiSchema.optional(),
    /** Optional base URL override for this model. */
    baseUrl: z.string().min(1).optional(),
    reasoning: z.boolean().optional(),
    input: z
      .array(
        z.union([z.literal("text"), z.literal("image"), z.literal("video"), z.literal("audio")]),
      )
      .optional(),
    cost: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
        tieredPricing: z
          .array(
            z
              .object({
                input: z.number(),
                output: z.number(),
                cacheRead: z.number(),
                cacheWrite: z.number(),
                range: z.union([z.tuple([z.number(), z.number()]), z.tuple([z.number()])]),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    /** Provider/native maximum context window in tokens. */
    contextWindow: z.number().positive().optional(),
    /**
     * Optional effective runtime cap used for compaction/session budgeting.
     * Keeps provider/native contextWindow metadata intact while letting configs
     * prefer a smaller practical window.
     */
    contextTokens: z.number().int().positive().optional(),
    maxTokens: z.number().positive().optional(),
    /** Maps OpenClaw thinking levels to provider/model-specific values. */
    thinkingLevelMap: ThinkingLevelMapSchema.optional(),
    /** Provider-specific request/runtime parameters passed through to provider plugins. */
    params: z.record(z.string(), z.unknown()).optional(),
    /** Optional agent execution runtime override for this provider/model pair. */
    agentRuntime: ModelAgentRuntimePolicySchema,
    /** Static headers merged into requests for this model. */
    headers: z.record(z.string(), z.string()).optional(),
    /** Provider compatibility flags for payload shaping and feature gating. */
    compat: ModelCompatSchema,
    /** Media input limits used by routing and preflight compression. */
    mediaInput: ModelMediaInputSchema.optional(),
    /** Metadata source marker for models added by CLI/catalog tooling. */
    metadataSource: z.literal("models-add").optional(),
  })
  .strict();

const ModelProviderLocalServiceSchema = z
  .object({
    /** Executable started before model requests are sent. */
    command: z.string().min(1),
    /** Arguments passed without shell expansion. */
    args: z.array(z.string()).optional(),
    /** Working directory for the local service process. */
    cwd: z.string().min(1).optional(),
    /** Environment variables added to the service process. */
    env: z.record(z.string(), z.string().register(sensitive)).optional(),
    /** Optional health endpoint polled before the provider is considered ready. */
    healthUrl: z.string().min(1).optional(),
    /** Startup readiness timeout in milliseconds. */
    readyTimeoutMs: z.number().int().positive().optional(),
    /** Idle timeout in milliseconds before stopping the local service. */
    idleStopMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const ModelProviderSchema = z
  .object({
    // Bundled provider overlays are materialized with an empty-string sentinel.
    // ModelProvidersSchema below still rejects empty baseUrl values for custom providers.
    baseUrl: z.string().optional(),
    /** API key or secret reference for this provider. */
    apiKey: SecretInputSchema.optional().register(sensitive),
    /** Authentication mode used when resolving credentials for this provider. */
    auth: z
      .union([z.literal("api-key"), z.literal("aws-sdk"), z.literal("oauth"), z.literal("token")])
      .optional(),
    /** Default API adapter for models under this provider. */
    api: ModelApiSchema.optional(),
    /** Provider-level default max output tokens. */
    maxTokens: z.number().positive().optional(),
    /** Provider request timeout in seconds. */
    timeoutSeconds: z.number().int().positive().optional(),
    /** Optional provider deployment/API region used by provider plugins that expose regional endpoints. */
    region: z.string().min(1).optional(),
    injectNumCtxForOpenAICompat: z.boolean().optional(),
    /** Provider-specific runtime parameters interpreted by provider plugins. */
    params: z.record(z.string(), z.unknown()).optional(),
    /** Optional default agent execution runtime for models under this provider. */
    agentRuntime: ModelAgentRuntimePolicySchema,
    /** Optional local service to start before calling this provider. */
    localService: ModelProviderLocalServiceSchema,
    /** Secret-bearing headers merged into provider requests. */
    headers: z.record(z.string(), SecretInputSchema.register(sensitive)).optional(),
    /** Whether default Authorization header injection is enabled. */
    authHeader: z.boolean().optional(),
    /** Provider request transport/retry overrides. */
    request: ConfiguredModelProviderRequestSchema,
    models: z.array(ModelDefinitionSchema).optional(),
  })
  .strict();

const ModelProvidersSchema = z
  .record(z.string(), ModelProviderSchema)
  .superRefine((providers, ctx) => {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (isBuiltInModelProviderOverlayId(providerId)) {
        continue;
      }
      if (!provider.baseUrl) {
        ctx.addIssue({
          code: "custom",
          path: [providerId, "baseUrl"],
          message:
            "custom model providers must declare baseUrl; provider overlays without baseUrl are only supported for bundled providers",
        });
      }
      if (!Array.isArray(provider.models)) {
        ctx.addIssue({
          code: "custom",
          path: [providerId, "models"],
          message:
            "custom model providers must declare models; provider overlays without models are only supported for bundled providers",
        });
      }
    }
  });

const ModelCatalogRefreshConfigSchema = z
  .object({
    /** Fetch model catalog updates from the hosted OpenClaw catalog. Default: true. */
    enabled: z.boolean().optional(),
    /** Override the hosted catalog URL (HTTPS mirrors, or localhost HTTP for testing). */
    url: z
      .string()
      .refine(
        (value) => {
          try {
            const parsed = new URL(value);
            return (
              parsed.protocol === "https:" ||
              (parsed.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
            );
          } catch {
            return false;
          }
        },
        {
          message: "models.catalogRefresh.url must use https, or http on localhost",
        },
      )
      .optional(),
  })
  .strict()
  .optional();

export const ModelsConfigSchema = z
  .object({
    /** Merge provider config with bundled catalogs or replace bundled catalogs entirely. */
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: ModelProvidersSchema.optional(),
    /** Hosted model catalog refresh settings. */
    catalogRefresh: ModelCatalogRefreshConfigSchema,
  })
  .strict()
  .optional();

export const IdentitySchema = z
  .object({
    name: z.string().optional(),
    theme: z.string().optional(),
    emoji: z.string().optional(),
    avatar: z.string().optional(),
  })
  .strict()
  .optional();

export const ReplyToModeSchema = z.union([
  z.literal("off"),
  z.literal("first"),
  z.literal("all"),
  z.literal("batched"),
]);
export const TypingModeSchema = z.union([
  z.literal("never"),
  z.literal("instant"),
  z.literal("thinking"),
  z.literal("message"),
]);

export const GroupPolicySchema = z.enum(["open", "disabled", "allowlist"]);

export const DmPolicySchema = z.enum(["pairing", "allowlist", "open", "disabled"]);
export const ContextVisibilityModeSchema = z.enum(["all", "allowlist", "allowlist_quote"]);

export const BlockStreamingCoalesceSchema = z
  .object({
    minChars: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    idleMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const TextChunkModeSchema = z.enum(["length", "newline"]);

export const ChannelStreamingBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    coalesce: BlockStreamingCoalesceSchema.optional(),
  })
  .strict();

/** Delivery-only nested streaming config for channels without preview modes. */
export const ChannelDeliveryStreamingConfigSchema = z
  .object({
    chunkMode: TextChunkModeSchema.optional(),
    block: ChannelStreamingBlockSchema.optional(),
  })
  .strict();

export const ReplyRuntimeConfigSchemaShape = {
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  streaming: ChannelDeliveryStreamingConfigSchema.optional(),
  responsePrefix: z.string().optional(),
  mediaMaxMb: z.number().positive().optional(),
};

export const BlockStreamingChunkSchema = z
  .object({
    minChars: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    breakPreference: z
      .union([z.literal("paragraph"), z.literal("newline"), z.literal("sentence")])
      .optional(),
  })
  .strict();

const MarkdownTableModeSchema = z.enum(["off", "bullets", "code", "block"]);

export const MarkdownConfigSchema = z
  .object({
    tables: MarkdownTableModeSchema.optional(),
  })
  .strict()
  .optional();

export const TtsProviderSchema = z.string().min(1);
export const TtsModeSchema = z.enum(["final", "all"]);
export const TtsAutoSchema = z.enum(["off", "always", "inbound", "tagged"]);
const TtsProviderConfigSchema = z
  .object({
    apiKey: SecretInputSchema.optional().register(sensitive),
  })
  .catchall(
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.unknown()),
      z.record(z.string(), z.unknown()),
    ]),
  );
const TtsPersonaSchema = z
  .object({
    label: z.string().optional(),
    description: z.string().optional(),
    provider: TtsProviderSchema.optional(),
    fallbackPolicy: z
      .union([z.literal("preserve-persona"), z.literal("provider-defaults"), z.literal("fail")])
      .optional(),
    providers: z.record(z.string(), TtsProviderConfigSchema).optional(),
  })
  .strict();
export const TtsConfigSchema = z
  .object({
    auto: TtsAutoSchema.optional(),
    enabled: z.boolean().optional(),
    mode: TtsModeSchema.optional(),
    provider: TtsProviderSchema.optional(),
    persona: z.string().optional(),
    personas: z.record(z.string(), TtsPersonaSchema).optional(),
    summaryModel: z.string().optional(),
    modelOverrides: z
      .object({
        enabled: z.boolean().optional(),
        allowText: z.boolean().optional(),
        allowProvider: z.boolean().optional(),
        allowVoice: z.boolean().optional(),
        allowModelId: z.boolean().optional(),
        allowVoiceSettings: z.boolean().optional(),
        allowNormalization: z.boolean().optional(),
        allowSeed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    providers: z.record(z.string(), TtsProviderConfigSchema).optional(),
    maxTextLength: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  })
  .strict()
  .optional();

export const HumanDelaySchema = z
  .object({
    mode: z.union([z.literal("off"), z.literal("natural"), z.literal("custom")]).optional(),
    minMs: z.number().int().nonnegative().optional(),
    maxMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const normalizeAllowFrom = (values?: Array<string | number>): string[] =>
  normalizeStringEntries(values);

/**
 * Closed set of sender-policy/allowFrom dependency violations. Both cases drop
 * every inbound DM at runtime, so callers surface them as config problems.
 */
export type DmPolicyAllowFromViolation = "open_requires_wildcard" | "allowlist_requires_entries";

/**
 * Canonical cross-field check for dmPolicy vs allowFrom. This is the single
 * source of truth shared by the Zod schema refinements and the CLI config
 * validator so the rule cannot drift between the two surfaces.
 */
export const evaluateDmPolicyAllowFromDependency = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
}): DmPolicyAllowFromViolation | null => {
  const allow = normalizeAllowFrom(params.allowFrom);
  if (params.policy === "open" && !allow.includes("*")) {
    return "open_requires_wildcard";
  }
  if (params.policy === "allowlist" && allow.length === 0) {
    return "allowlist_requires_entries";
  }
  return null;
};

export const requireOpenAllowFrom = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => {
  if (
    evaluateDmPolicyAllowFromDependency({ policy: params.policy, allowFrom: params.allowFrom }) !==
    "open_requires_wildcard"
  ) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
};

/**
 * Validate that dmPolicy="allowlist" has a non-empty allowFrom array.
 * Without this, all DMs are silently dropped because the allowlist is empty
 * and no senders can match.
 */
export const requireAllowlistAllowFrom = (params: {
  policy?: string;
  allowFrom?: Array<string | number>;
  ctx: z.RefinementCtx;
  path: Array<string | number>;
  message: string;
}) => {
  if (
    evaluateDmPolicyAllowFromDependency({ policy: params.policy, allowFrom: params.allowFrom }) !==
    "allowlist_requires_entries"
  ) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path,
    message: params.message,
  });
};

export const MSTeamsReplyStyleSchema = z.enum(["thread", "top-level"]);

export const HexColorSchema = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");

export const ExecutableTokenSchema = z
  .string()
  .refine(isSafeExecutableValue, "expected safe executable name or path");

const MediaUnderstandingScopeSchema = createAllowDenyChannelRulesSchema();

const MediaUnderstandingAttachmentsSchema = z
  .object({
    /** Select the first matching attachment or process multiple. */
    mode: z.union([z.literal("first"), z.literal("all")]).optional(),
    /** Max number of attachments to process (default: 1). */
    maxAttachments: z.number().int().positive().optional(),
    /** Attachment ordering preference. */
    prefer: z
      .union([z.literal("first"), z.literal("last"), z.literal("path"), z.literal("url")])
      .optional(),
  })
  .strict()
  .optional();

const MediaUnderstandingCapabilitiesSchema = z
  .array(z.union([z.literal("image"), z.literal("audio"), z.literal("video")]))
  .optional();

const ProviderOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const ProviderOptionsSchema = z
  .record(z.string(), z.record(z.string(), ProviderOptionValueSchema))
  .optional();

const MediaUnderstandingRuntimeFields = {
  /** Optional prompt override for this model entry. */
  /** Default prompt. */
  prompt: z.string().optional(),
  /** Optional timeout override (seconds) for this model entry. */
  /** Default timeout (seconds). */
  timeoutSeconds: z.number().int().positive().optional(),
  /** Optional language hint for audio transcription. */
  /** Default language hint (audio). */
  language: z.string().optional(),
  /** Optional provider-specific query params (merged into requests). */
  providerOptions: ProviderOptionsSchema,
  /** Optional base URL override for provider requests. */
  baseUrl: z.string().optional(),
  /** Optional headers merged into provider requests. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Optional request transport overrides for provider HTTP calls. */
  request: ConfiguredProviderRequestSchema,
};

const MediaUnderstandingModelSchema = z
  .object({
    /** provider API id (e.g. openai, google). */
    provider: z.string().optional(),
    /** Model id for provider-based understanding. */
    model: z.string().optional(),
    /** Optional capability tags for shared model lists. */
    capabilities: MediaUnderstandingCapabilitiesSchema,
    /** Use a CLI command instead of provider API. */
    type: z.union([z.literal("provider"), z.literal("cli")]).optional(),
    /** CLI binary (required when type=cli). */
    command: z.string().optional(),
    /** CLI args (template-enabled). */
    args: z.array(z.string()).optional(),
    /** Optional max output characters for this model entry. */
    maxChars: z.number().int().positive().optional(),
    /** Optional max bytes for this model entry. */
    maxBytes: z.number().int().positive().optional(),
    ...MediaUnderstandingRuntimeFields,
    /** Auth profile id to use for this provider. */
    profile: z.string().optional(),
    /** Preferred profile id if multiple are available. */
    preferredProfile: z.string().optional(),
  })
  .strict()
  .optional();

const ToolsMediaCapabilitySchema = z
  .object({
    enabled: z.boolean().optional(),
    preferredModel: z.string().trim().min(1).optional(),
    scope: MediaUnderstandingScopeSchema,
    maxBytes: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    ...MediaUnderstandingRuntimeFields,
    attachments: MediaUnderstandingAttachmentsSchema,
  })
  .strict()
  .optional();

const ToolsMediaAudioSchema = z
  .object({
    /** Enable media understanding when models are configured. */
    enabled: z.boolean().optional(),
    /** Prefer a matching shared model entry. */
    preferredModel: z.string().trim().min(1).optional(),
    /** Optional scope gating for understanding. */
    scope: MediaUnderstandingScopeSchema,
    /** Default max bytes to send. */
    maxBytes: z.number().int().positive().optional(),
    /** Default max output characters. */
    maxChars: z.number().int().positive().optional(),
    ...MediaUnderstandingRuntimeFields,
    /** Attachment selection policy. */
    attachments: MediaUnderstandingAttachmentsSchema,
    /**
     * Echo the audio transcript back to the originating chat before agent processing.
     * Lets users verify what was heard. Default: false.
     */
    echoTranscript: z.boolean().optional(),
    /**
     * Format string for the echoed transcript. Use `{transcript}` as placeholder.
     * Default: '📝 "{transcript}"'
     */
    echoFormat: z.string().optional(),
  })
  .strict()
  .optional();

export const ToolsMediaSchema = z
  .object({
    models: z.array(MediaUnderstandingModelSchema).optional(),
    concurrency: z.number().int().positive().optional(),
    image: ToolsMediaCapabilitySchema.optional(),
    audio: ToolsMediaAudioSchema.optional(),
    video: ToolsMediaCapabilitySchema.optional(),
  })
  .strict()
  .optional();
const LinkModelSchema = z
  .object({
    /** Use a CLI command for link processing. */
    type: z.literal("cli").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict();

export const ToolsLinksSchema = z
  .object({
    /** Enable link understanding when models are configured. */
    enabled: z.boolean().optional(),
    scope: MediaUnderstandingScopeSchema,
    /** Max number of links to process per message. */
    maxLinks: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    /** Ordered model list (fallbacks in order). */
    models: z.array(LinkModelSchema).optional(),
  })
  .strict()
  .optional();

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
