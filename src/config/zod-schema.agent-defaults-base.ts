// Defines Zod schema fragments for agent default configuration.
import { z } from "zod";
import { isValidNonNegativeByteSizeString } from "./byte-size.js";
import { AgentModelMapSchema, AgentModelPolicySchema } from "./zod-schema.agent-entry-base.js";
import { AgentModelSchema, AgentToolModelSchema } from "./zod-schema.agent-model.js";

const SilentReplyPolicySchema = z.union([z.literal("allow"), z.literal("disallow")]);

const NonNegativeByteSizeSchema = z.union([
  z.number().int().nonnegative(),
  z.string().refine(isValidNonNegativeByteSizeString, "Expected byte size string like 2mb"),
]);

const OptionalBootstrapFileNameSchema = z.enum([
  "SOUL.md",
  "USER.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
]);

const AgentThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "ultra",
]);

const EmbeddedAgentConfigSchema = z
  .object({
    projectSettingsPolicy: z
      .union([z.literal("trusted"), z.literal("sanitize"), z.literal("ignore")])
      .optional(),
    executionContract: z.union([z.literal("default"), z.literal("strict-agentic")]).optional(),
    cyberFailover: z
      .object({
        mode: z.union([z.literal("auto"), z.literal("off")]).optional(),
        model: z.string().min(1).optional(),
        cooloffMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const SilentReplyPolicyConfigSchema = z
  .object({
    group: SilentReplyPolicySchema.optional(),
    internal: SilentReplyPolicySchema.optional(),
  })
  .strict();

export const AgentDefaultsBaseSchema = z
  .object({
    /** Global default provider params applied to all models before per-model and per-agent overrides. */
    params: z.record(z.string(), z.unknown()).optional(),
    model: AgentModelSchema.optional(),
    modelSelectionScope: z.enum(["session", "agent", "global"]).optional(),
    utilityModel: z.string().optional(),
    imageModel: AgentToolModelSchema.optional(),
    mediaModels: z
      .object({
        image: AgentToolModelSchema.optional(),
        video: AgentToolModelSchema.optional(),
        music: AgentToolModelSchema.optional(),
      })
      .strict()
      .optional(),
    voiceModel: AgentToolModelSchema.optional(),
    pdfModel: AgentToolModelSchema.optional(),
    pdfMaxMb: z.number().positive().optional(),
    pdfMaxPages: z.number().int().positive().optional(),
    models: AgentModelMapSchema.optional(),
    modelPolicy: AgentModelPolicySchema.optional(),
    workspace: z.string().optional(),
    cwd: z.string().optional(),
    skills: z.array(z.string()).optional(),
    silentReply: SilentReplyPolicyConfigSchema.optional(),
    repoRoot: z.string().optional(),
    skipBootstrap: z.boolean().optional(),
    skipOptionalBootstrapFiles: z.array(OptionalBootstrapFileNameSchema).optional(),
    contextInjection: z
      .union([z.literal("always"), z.literal("continuation-skip"), z.literal("never")])
      .optional(),
    bootstrapMaxChars: z.number().int().positive().optional(),
    bootstrapTotalMaxChars: z.number().int().positive().optional(),
    experimental: z
      .object({
        localModelLean: z.boolean().optional(),
      })
      .strict()
      .optional(),
    userTimezone: z.string().optional(),
    startupContext: z
      .object({
        /** Enable runtime-owned startup-context prelude on bare session resets (default: true). */
        enabled: z.boolean().optional(),
        /** Which bare reset commands should receive startup context (default: ["new", "reset"]). */
        applyOn: z.array(z.union([z.literal("new"), z.literal("reset")])).optional(),
        /** How many dated memory files to load counting backward from today (default: 2). */
        dailyMemoryDays: z.number().int().min(1).max(14).optional(),
        /** Max bytes to read from each daily memory file before skipping (default: 16384). */
        maxFileBytes: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024)
          .optional(),
        /** Max characters retained from each daily memory file (default: 1200). */
        maxFileChars: z.number().int().min(1).max(10_000).optional(),
        /** Max total characters retained across the startup prelude (default: 2800). */
        maxTotalChars: z.number().int().min(1).max(50_000).optional(),
      })
      .strict()
      .optional(),
    contextPruning: z
      .object({
        /** Pruning mode for old tool results in model context. */
        mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
        /** TTL to consider cache expired (duration string, default unit: minutes). */
        ttl: z.string().optional(),
        tools: z
          .object({
            /** Tool names eligible for context pruning. */
            allow: z.array(z.string()).optional(),
            /** Tool names excluded from context pruning. */
            deny: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        hardClear: z
          .object({
            /** Replace oversized old tool results with a placeholder at high pressure. */
            enabled: z.boolean().optional(),
            /** Placeholder text inserted when a tool result is hard-cleared. */
            placeholder: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    compaction: z
      .object({
        /** Enable embedded proactive auto-compaction. Default: true. */
        enabled: z.boolean().optional(),
        /** Compaction summarization mode. */
        mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
        /**
         * Id of a registered compaction provider plugin.
         * When set, the provider's summarize() is called instead of
         * the built-in summarizeInStages(). Falls back to built-in on failure.
         */
        provider: z.string().optional(),
        /** Thinking level for embedded OpenClaw compaction summaries. Default: low. */
        thinkingLevel: z.union([AgentThinkingLevelSchema, z.literal("inherit")]).optional(),
        /** Embedded OpenClaw keepRecentTokens budget used for cut-point selection. */
        keepRecentTokens: z.number().int().positive().optional(),
        /** Identifier-preservation instruction policy for compaction summaries. */
        identifierPolicy: z.union([z.literal("strict"), z.literal("off")]).optional(),
        /** Preserve this many most-recent user/assistant turns verbatim in compaction summary context. */
        recentTurnsPreserve: z.number().int().min(0).max(12).optional(),
        /** Optional quality-audit retries for safeguard compaction summaries. */
        qualityGuard: z
          .object({
            /** Enable compaction summary quality audits and regeneration retries. Default: false. */
            enabled: z.boolean().optional(),
            /** Maximum regeneration retries after a failed quality audit. Default: 1 when enabled. */
            maxRetries: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        /** Mid-turn precheck for tool-loop context pressure. Default: disabled. */
        midTurnPrecheck: z
          .object({
            /**
             * Enable structured context pressure checks after tool results are appended
             * and before the next agent model call. Default: false.
             */
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        /** Post-compaction session memory index sync mode. */
        postIndexSync: z.enum(["off", "async", "await"]).optional(),
        /** H2/H3 section names from AGENTS.md to inject after compaction. */
        postCompactionSections: z.array(z.string()).optional(),
        /** Optional provider/model or configured bare alias for compaction summarization.
         * When set, compaction uses this model instead of the agent's primary model.
         * Falls back to the primary model when unset. */
        model: z.string().optional(),
        /** Safety window in seconds for each built-in compaction model request (default: 180). */
        timeoutSeconds: z.number().int().positive().optional(),
        /** Pre-compaction memory flush (agentic turn). Default: enabled. */
        memoryFlush: z
          .object({
            /** Enable the pre-compaction memory flush (default: true). */
            enabled: z.boolean().optional(),
            /** Optional provider/model override used only for pre-compaction memory flush turns. */
            model: z.string().optional(),
            /** Run the memory flush when context is within this many tokens of the compaction threshold. */
            softThresholdTokens: z.number().int().nonnegative().optional(),
            /**
             * Force a memory flush when transcript size reaches this threshold
             * (bytes, or byte-size string like "2mb"). Set to 0 to disable.
             */
            forceFlushTranscriptBytes: NonNegativeByteSizeSchema.optional(),
          })
          .strict()
          .optional(),
        /**
         * Byte threshold for normal preflight local compaction (bytes, or a byte-size
         * string like "20mb"). Set to 0 or leave unset to disable. Also caps Codex
         * app-server native rollouts; oversized native threads restart fresh.
         */
        maxActiveTranscriptBytes: NonNegativeByteSizeSchema.optional(),
        /**
         * Send brief context-maintenance notices to the user: when compaction starts
         * and completes, and when a pre-compaction memory flush is exhausted so the
         * reply continues in a degraded state.
         * Default: false (silent by default).
         */
        notifyUser: z.boolean().optional(),
      })
      .strict()
      .optional(),
    embeddedAgent: EmbeddedAgentConfigSchema.optional(),
    thinkingDefault: AgentThinkingLevelSchema.optional(),
    fastModeDefault: z.union([z.boolean(), z.literal("auto")]).optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on"), z.literal("full")]).optional(),
    toolProgressDetail: z.union([z.literal("explain"), z.literal("raw")]).optional(),
    reasoningDefault: z.union([z.literal("off"), z.literal("on"), z.literal("stream")]).optional(),
    elevatedDefault: z
      .union([z.literal("off"), z.literal("on"), z.literal("ask"), z.literal("full")])
      .optional(),
    blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
    // 0 = unlimited run budget; stream liveness watchdogs still apply.
    timeoutSeconds: z.number().int().nonnegative().optional(),
    mediaMaxMb: z.number().positive().optional(),
    imageMaxDimensionPx: z.number().int().positive().optional(),
    imageQuality: z.enum(["auto", "efficient", "balanced", "high"]).optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    systemAgent: z
      .object({
        agentId: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    authInheritance: z
      .object({
        agentId: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    sessionStore: z
      .object({
        agentId: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    maxConcurrent: z.number().int().positive().optional(),
    subagents: z
      .object({
        delegationMode: z.enum(["suggest", "prefer"]).optional(),
        allowAgents: z.array(z.string()).optional(),
        maxConcurrent: z.number().int().positive().optional(),
        maxSpawnDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Maximum nesting depth for sub-agent spawning. Default: 5; 1 makes direct children leaves.",
          ),
        maxChildrenPerAgent: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Maximum number of active children a single agent session can spawn (default: 5).",
          ),
        archiveAfterMinutes: z.number().int().min(0).optional(),
        model: AgentModelSchema.optional(),
        thinking: z.string().optional(),
        runTimeoutSeconds: z.number().int().min(0).optional(),
        announceTimeoutMs: z.number().int().positive().optional(),
        requireAgentId: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
