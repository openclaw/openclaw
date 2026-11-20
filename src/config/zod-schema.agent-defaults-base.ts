import { z } from "zod";
import { ALL_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
import { isValidNonNegativeByteSizeString } from "./byte-size.js";
import {
  AgentCompactionMaxSummaryCharsSchema,
  AgentModelMapSchema,
  AgentModelPolicySchema,
  WorkspaceFileModeSchema,
} from "./zod-schema.agent-entry-base.js";
import {
  AgentModelSchema,
  AgentToolModelSchema,
  DecisionModelSchema,
} from "./zod-schema.agent-model.js";

const NonNegativeByteSizeSchema = z.union([
  z.number().int().nonnegative(),
  z.string().refine(isValidNonNegativeByteSizeString, "Expected byte size string like 2mb"),
]);

const AgentThinkingLevelSchema = z.enum(ALL_THINKING_LEVELS);

const EmbeddedAgentConfigSchema = z.strictObject({
  projectSettingsPolicy: z
    .union([z.literal("trusted"), z.literal("sanitize"), z.literal("ignore")])
    .optional(),
  executionContract: z.union([z.literal("default"), z.literal("strict-agentic")]).optional(),
  cyberFailover: z
    .strictObject({
      mode: z.union([z.literal("auto"), z.literal("off")]).optional(),
      cooloffMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export const SilentReplyPolicyConfigSchema = z.strictObject({
  group: z.union([z.literal("allow"), z.literal("disallow")]).optional(),
});

const AgentOwnerTargetSchema = z
  .strictObject({
    agentId: z.string().trim().min(1).optional(),
  })
  .optional();

export const AgentDefaultsBaseSchema = z.strictObject({
  /** Global default provider params applied to all models before per-model and per-agent overrides. */
  params: z.record(z.string(), z.unknown()).optional(),
  model: AgentModelSchema.optional(),
  modelSelectionScope: z.enum(["session", "agent", "global"]).optional(),
  utilityModel: AgentModelSchema.optional(),
  decisionModel: DecisionModelSchema.optional(),
  imageModel: AgentToolModelSchema.optional(),
  mediaModels: z
    .strictObject({
      image: AgentToolModelSchema.optional(),
      video: AgentToolModelSchema.optional(),
      music: AgentToolModelSchema.optional(),
    })
    .optional(),
  voiceModel: AgentToolModelSchema.optional(),
  pdfModel: AgentToolModelSchema.optional(),
  pdfMaxMb: z.number().positive().optional(),
  pdfMaxPages: z.number().int().positive().optional(),
  models: AgentModelMapSchema.optional(),
  modelPolicy: AgentModelPolicySchema.optional(),
  workspace: z.string().optional(),
  workspaceFileMode: WorkspaceFileModeSchema.optional(),
  cwd: z.string().optional(),
  skills: z.array(z.string()).optional(),
  silentReply: SilentReplyPolicyConfigSchema.optional(),
  repoRoot: z.string().optional(),
  skipBootstrap: z.boolean().optional(),
  skipOptionalBootstrapFiles: z
    .array(z.enum(["SOUL.md", "USER.md", "HEARTBEAT.md", "IDENTITY.md"]))
    .optional(),
  contextInjection: z
    .union([z.literal("always"), z.literal("continuation-skip"), z.literal("never")])
    .optional(),
  bootstrapMaxChars: z.number().int().positive().optional(),
  bootstrapTotalMaxChars: z.number().int().positive().optional(),
  experimental: z
    .strictObject({
      /** Global opt-in for automatic Decision experiments; model selection is separate. */
      decisionAssistance: z.boolean().optional(),
      usageRankedToolIndex: z.boolean().optional(),
      localModelLean: z.boolean().optional(),
    })
    .optional(),
  userTimezone: z.string().optional(),
  startupContext: z
    .strictObject({
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
    .optional(),
  contextPruning: z
    .strictObject({
      /** Pruning mode for old tool results in model context. */
      mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
      /** TTL to consider cache expired (duration string, default unit: minutes). */
      ttl: z.string().optional(),
      tools: z
        .strictObject({
          /** Tool names eligible for context pruning. */
          allow: z.array(z.string()).optional(),
          /** Tool names excluded from context pruning. */
          deny: z.array(z.string()).optional(),
        })
        .optional(),
      hardClear: z
        .strictObject({
          /** Replace oversized old tool results with a placeholder at high pressure. */
          enabled: z.boolean().optional(),
          /** Placeholder text inserted when a tool result is hard-cleared. */
          placeholder: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  compaction: z
    .strictObject({
      /** Enable embedded proactive auto-compaction. Default: true. */
      enabled: z.boolean().optional(),
      mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
      /**
       * Id of a registered compaction provider plugin.
       * When set, the provider's summarize() is called instead of the
       * built-in summary request. Falls back to built-in on failure.
       */
      provider: z.string().optional(),
      /** Thinking level for embedded OpenClaw compaction summaries. Default: low. */
      thinkingLevel: z.union([AgentThinkingLevelSchema, z.literal("inherit")]).optional(),
      /** Embedded OpenClaw keepRecentTokens budget used for cut-point selection. */
      keepRecentTokens: z.number().int().positive().optional(),
      /** Maximum persisted client-side summary characters. Default: 16000. */
      maxSummaryChars: AgentCompactionMaxSummaryCharsSchema.optional(),
      /** Identifier-preservation instruction policy for compaction summaries. */
      identifierPolicy: z.union([z.literal("strict"), z.literal("off")]).optional(),
      /** Preserve this many most-recent user/assistant turns verbatim in compaction summary context. */
      recentTurnsPreserve: z.number().int().min(0).max(12).optional(),
      /** Optional quality-audit retries for safeguard compaction summaries. */
      qualityGuard: z
        .strictObject({
          /** Enable compaction summary quality audits and regeneration retries. Default: false. */
          enabled: z.boolean().optional(),
          /** Maximum regeneration retries after a failed quality audit. Default: 1 when enabled. */
          maxRetries: z.number().int().nonnegative().optional(),
        })
        .optional(),
      /** Optional estimated-pressure threshold; hard window admission remains active. */
      midTurnPrecheck: z
        .strictObject({
          /**
           * Reserve compaction headroom against estimated tool-loop pressure. Default: false.
           */
          enabled: z.boolean().optional(),
        })
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
        .strictObject({
          /** Enable the pre-compaction memory flush (default: true). */
          enabled: z.boolean().optional(),
          /** Run the memory flush when context is within this many tokens of the compaction threshold. */
          softThresholdTokens: z.number().int().nonnegative().optional(),
          /**
           * Force a memory flush when transcript size reaches this threshold
           * (bytes, or byte-size string like "2mb"). Set to 0 to disable.
           */
          forceFlushTranscriptBytes: NonNegativeByteSizeSchema.optional(),
        })
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
    .optional(),
  embeddedAgent: EmbeddedAgentConfigSchema.optional(),
  thinkingDefault: AgentThinkingLevelSchema.optional(),
  fastModeDefault: z.union([z.boolean(), z.literal("auto"), z.literal("ultrafast")]).optional(),
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
  systemAgent: AgentOwnerTargetSchema,
  authInheritance: AgentOwnerTargetSchema,
  sessionStore: AgentOwnerTargetSchema,
  maxConcurrent: z.number().int().positive().optional(),
  subagents: z
    .strictObject({
      delegationMode: z.enum(["suggest", "prefer"]).optional(),
      allowAgents: z.array(z.string()).optional(),
      maxConcurrent: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum concurrent child-agent runs per immediate spawning/controller session (default: 8). Independent sessions have independent budgets.",
        ),
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
    .optional(),
  /** Agent self-elected turn continuation (CONTINUE_WORK signal). */
  continuation: z
    .strictObject({
      enabled: z.boolean().optional(),
      // Bounds are tightened to match semantic expectations. Clamp helpers
      // in continuation/config.ts still apply at read time as a belt-and-braces layer.
      defaultDelayMs: z.number().int().nonnegative().optional(),
      minDelayMs: z.number().int().nonnegative().optional(),
      maxDelayMs: z.number().int().nonnegative().optional(),
      maxChainLength: z.number().int().positive().optional(),
      costCapTokens: z.number().int().nonnegative().optional(),
      /** Maximum number of continue_delegate tool calls per agent turn (default: 5). */
      maxDelegatesPerTurn: z.number().int().positive().optional(),
      /**
       * Maximum concurrent undelivered continue_work flows per session
       * (default: 32). Enforced at enqueue; bounds the multi-continue_work flood
       * independently of maxChainLength (lineage depth).
       */
      maxPendingWork: z.number().int().positive().optional(),
      /**
       * Busy-skip exponential backoff bounds for the continue_work re-arm (rate-cap,
       * not a safety invariant). `baseMs` (default 1000) is the first re-arm delay,
       * multiplied by `factor` (default 2) per consecutive busy-skip up to
       * `ceilingMs` (default: maxDelayMs). The ceiling is the give-up rate-cap —
       * the flow keeps deferring at this rate forever, never dropped.
       */
      busySkipBackoff: z
        .strictObject({
          /** First re-arm delay in ms (default 1000). */
          baseMs: z.number().int().positive().optional(),
          /** Maximum re-arm delay / give-up rate-cap in ms (default: maxDelayMs). */
          ceilingMs: z.number().int().positive().optional(),
          /** Exponential growth factor per consecutive busy-skip (default 2, must be > 1). */
          factor: z.number().gt(1).optional(),
        })
        .optional(),
      /**
       * Orphan-reap confidence-gate floor in ms. An unended subagent run is
       * treated as confident-terminal (reap-eligible) only after it ages past this
       * cutoff; unset uses the subagent-registry default (2h). The per-run timeout
       * is always respected. Safety invariants (uncertain→quiesce,
       * never-wrongful-reap) are fixed — only this confidence window is tunable.
       */
      orphanReapStaleCutoffMs: z.number().int().positive().optional(),
      /**
       * Cross-session delegate targeting policy.
       * - `"disabled"` (default): delegates can return to the dispatching session or
       *   use `fanoutMode: "tree"` for lineage-only routing. Non-self `targetSessionKey`,
       *   `targetSessionKeys` containing any non-self session, and `fanoutMode: "all"`
       *   are rejected with a tool error.
       * - `"enabled"`: all targeting modes are available, including cross-session
       *   `targetSessionKey`, `targetSessionKeys`, and `fanoutMode: "all"`.
       *
       * `fanoutMode: "tree"` (lineage-only return) is always allowed regardless of this setting.
       * Self-targeting (`targetSessionKey` matching the dispatching session) is always allowed.
       */
      crossSessionTargeting: z
        .union([z.literal("disabled"), z.literal("enabled")])
        .default("disabled"),
      /**
       * Context-pressure awareness threshold (exclusive (0.0, 1.0]). When the session's token
       * usage exceeds this fraction of the context window, a [system:context-pressure]
       * event is injected pre-run so the agent can elect evacuation. Disabled when
       * unset. Recommended: 0.8 (80%). On the built-in runtime this only enables the
       * events: they fire at token points below its resolved compaction trigger, because
       * compaction there runs at 75% of the window or earlier.
       */
      contextPressureThreshold: z
        .number()
        .gt(0, "contextPressureThreshold must be > 0 (0 would fire on empty sessions)")
        .max(1)
        .optional(),
      /**
       * Early-warning band as a fraction of contextPressureThreshold (default: 0.3125,
       * which fires at 25% when the threshold is 0.8). Set to 0 to opt out. Applies to
       * runtimes that keep their own compaction; the built-in runtime ignores it.
       */
      earlyWarningBand: z.number().min(0).max(1).default(0.3125),
    })
    .refine(
      (cfg) => {
        // min <= default <= max when all are set. Any omitted field skips
        // its side of the comparison.
        const min = cfg.minDelayMs;
        const def = cfg.defaultDelayMs;
        const max = cfg.maxDelayMs;
        if (min !== undefined && def !== undefined && min > def) {
          return false;
        }
        if (def !== undefined && max !== undefined && def > max) {
          return false;
        }
        if (min !== undefined && max !== undefined && min > max) {
          return false;
        }
        return true;
      },
      {
        message: "continuation delay bounds violate minDelayMs ≤ defaultDelayMs ≤ maxDelayMs",
      },
    )
    .optional(),
});
