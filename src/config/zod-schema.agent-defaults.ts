import { z } from "zod";
import { isValidNonNegativeByteSizeString } from "./byte-size.js";
import {
  HeartbeatSchema,
  AgentCompactionSchema,
  AgentContextPruningSchema,
  AgentSandboxSchema,
  AgentContextLimitsSchema,
  AgentModelRuntimeEntrySchema,
  AgentModelSchema,
  AgentToolModelSchema,
  MemorySearchSchema,
  AgentRunRetriesConfigSchema,
} from "./zod-schema.agent-runtime.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  CliBackendSchema,
  HumanDelaySchema,
  TypingModeSchema,
} from "./zod-schema.core.js";

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

const EmbeddedAgentConfigSchema = z
  .object({
    projectSettingsPolicy: z
      .union([z.literal("trusted"), z.literal("sanitize"), z.literal("ignore")])
      .optional(),
    executionContract: z.union([z.literal("default"), z.literal("strict-agentic")]).optional(),
  })
  .strict();

export const SilentReplyPolicyConfigSchema = z
  .object({
    group: SilentReplyPolicySchema.optional(),
    internal: SilentReplyPolicySchema.optional(),
  })
  .strict();

export const AgentDefaultsSchema = z
  .object({
    /** Global default provider params applied to all models before per-model and per-agent overrides. */
    params: z.record(z.string(), z.unknown()).optional(),
    model: AgentModelSchema.optional(),
    imageModel: AgentToolModelSchema.optional(),
    imageGenerationModel: AgentToolModelSchema.optional(),
    videoGenerationModel: AgentToolModelSchema.optional(),
    musicGenerationModel: AgentToolModelSchema.optional(),
    voiceModel: AgentToolModelSchema.optional(),
    mediaGenerationAutoProviderFallback: z.boolean().optional(),
    pdfModel: AgentToolModelSchema.optional(),
    pdfMaxBytesMb: z.number().positive().optional(),
    pdfMaxPages: z.number().int().positive().optional(),
    models: z.record(z.string(), AgentModelRuntimeEntrySchema).optional(),
    workspace: z.string().optional(),
    skills: z.array(z.string()).optional(),
    silentReply: SilentReplyPolicyConfigSchema.optional(),
    repoRoot: z.string().optional(),
    promptOverlays: z
      .object({
        gpt5: z
          .object({
            personality: z
              .union([z.literal("friendly"), z.literal("on"), z.literal("off")])
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
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
    bootstrapPromptTruncationWarning: z
      .union([z.literal("off"), z.literal("once"), z.literal("always")])
      .optional(),
    userTimezone: z.string().optional(),
    startupContext: z
      .object({
        enabled: z.boolean().optional(),
        applyOn: z.array(z.union([z.literal("new"), z.literal("reset")])).optional(),
        dailyMemoryDays: z.number().int().min(1).max(14).optional(),
        maxFileBytes: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024)
          .optional(),
        maxFileChars: z.number().int().min(1).max(10_000).optional(),
        maxTotalChars: z.number().int().min(1).max(50_000).optional(),
      })
      .strict()
      .optional(),
    contextLimits: AgentContextLimitsSchema,
    timeFormat: z.union([z.literal("auto"), z.literal("12"), z.literal("24")]).optional(),
    envelopeTimezone: z.string().optional(),
    envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
    envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
    contextTokens: z.number().int().positive().optional(),
    cliBackends: z.record(z.string(), CliBackendSchema).optional(),
    memorySearch: MemorySearchSchema,
    contextPruning: AgentContextPruningSchema,
    compaction: AgentCompactionSchema,
    runRetries: AgentRunRetriesConfigSchema.optional(),
    embeddedAgent: EmbeddedAgentConfigSchema.optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
        z.literal("xhigh"),
        z.literal("adaptive"),
        z.literal("max"),
      ])
      .optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on"), z.literal("full")]).optional(),
    toolProgressDetail: z.union([z.literal("explain"), z.literal("raw")]).optional(),
    reasoningDefault: z.union([z.literal("off"), z.literal("on"), z.literal("stream")]).optional(),
    elevatedDefault: z
      .union([z.literal("off"), z.literal("on"), z.literal("ask"), z.literal("full")])
      .optional(),
    blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
    blockStreamingChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    humanDelay: HumanDelaySchema.optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    imageMaxDimensionPx: z.number().int().positive().optional(),
    imageQuality: z.enum(["auto", "efficient", "balanced", "high"]).optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: TypingModeSchema.optional(),
    heartbeat: HeartbeatSchema,
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
            "Maximum nesting depth for sub-agent spawning. 1 = no nesting (default), 2 = sub-agents can spawn sub-sub-agents.",
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
    sandbox: AgentSandboxSchema,
  })
  .strict()
  .optional();
