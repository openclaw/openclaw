// Defines agent default configuration types shared by runtime schemas.
import type { z } from "zod";
import type {
  AgentRuntimePolicyConfig,
  AgentSandboxConfig,
  AgentToolModelConfig,
} from "./types.agents-shared.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  HumanDelayConfig,
  TypingMode,
} from "./types.base.js";
import type { AgentDefaultsBaseSchema } from "./zod-schema.agent-defaults-base.js";
import type { AgentContextLimitsSchema, HeartbeatSchema } from "./zod-schema.agent-runtime.js";

type SchemaAgentDefaultsConfig = z.input<typeof AgentDefaultsBaseSchema>;

/** Workspace bootstrap-file injection policy for agent system prompts. */
export type AgentContextInjection = "always" | "continuation-skip" | "never";
/**
 * Optional bootstrap files that setup can skip while still creating required
 * agent files. "HEARTBEAT.md" stays accepted as legacy config input even
 * though workspace setup no longer writes it.
 */
export type OptionalBootstrapFileName = "SOUL.md" | "USER.md" | "HEARTBEAT.md" | "IDENTITY.md";
/** Embedded runner behavior contract used by strict-agentic provider flows. */
export type EmbeddedAgentExecutionContract = "default" | "strict-agentic";
/** Prompt-only default for how strongly agents should delegate to sub-agents. */
export type SubagentDelegationMode = "suggest" | "prefer";
/** Image compression/detail preference used before sending image inputs to models. */
export type AgentImageQualityPreference = "auto" | "efficient" | "balanced" | "high";
/** Scope of an interactive model selection when no explicit scope is supplied. */
export type ModelSelectionScope = "session" | "agent" | "global";
/** Canonical thinking levels accepted by agent defaults and compaction overrides. */
export type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max"
  | "ultra";

export type AgentModelEntryConfig = NonNullable<SchemaAgentDefaultsConfig["models"]>[string];

export type AgentModelPolicyConfig = NonNullable<SchemaAgentDefaultsConfig["modelPolicy"]>;

export type AgentModelListConfig = {
  /** Primary provider/model ref. */
  primary?: string;
  /** Ordered provider/model fallback refs. */
  fallbacks?: string[];
};

export type AgentContextPruningConfig = NonNullable<SchemaAgentDefaultsConfig["contextPruning"]>;

export type AgentStartupContextConfig = NonNullable<SchemaAgentDefaultsConfig["startupContext"]>;

export type AgentContextLimitsConfig = NonNullable<z.input<typeof AgentContextLimitsSchema>>;

export type AgentDefaultsConfig = SchemaAgentDefaultsConfig & {
  /** @deprecated Doctor-only legacy input. */
  imageGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  videoGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  musicGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimezone?: string;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimestamp?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  envelopeElapsed?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  timeFormat?: "auto" | "12" | "24";
  /** @deprecated Doctor-only legacy input. */
  promptOverlays?: { gpt5?: { personality?: "friendly" | "on" | "off" } };
  /**
   * @deprecated Legacy raw config accepted only by doctor/migration repair.
   * Normal schema parsing rejects this key; use per-model agentRuntime instead.
   */
  agentRuntime?: AgentRuntimePolicyConfig;
  contextLimits?: AgentContextLimitsConfig;
  blockStreamingChunk?: BlockStreamingChunkConfig;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  humanDelay?: HumanDelayConfig;
  typingMode?: TypingMode;
  heartbeat?: NonNullable<z.input<typeof HeartbeatSchema>> & {
    agentId?: string;
  };
  sandbox?: AgentSandboxConfig;
};
export type AgentCompactionMode = "default" | "safeguard";
export type AgentCompactionPostIndexSyncMode = "off" | "async" | "await";
export type AgentCompactionIdentifierPolicy = "strict" | "off";
export type AgentCompactionQualityGuardConfig = NonNullable<AgentCompactionConfig["qualityGuard"]>;

export type AgentCompactionMidTurnPrecheckConfig = NonNullable<
  AgentCompactionConfig["midTurnPrecheck"]
>;

export type AgentCompactionConfig = NonNullable<SchemaAgentDefaultsConfig["compaction"]>;

export type AgentCompactionMemoryFlushConfig = NonNullable<AgentCompactionConfig["memoryFlush"]>;
