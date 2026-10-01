import type { z } from "zod";
import type {
  ChannelPreviewStreamingConfigSchema,
  ChannelStreamingProgressSchema,
  UnifiedStreamingModeSchema,
} from "./zod-schema.channel-messaging-common.js";
import type {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelStreamingBlockSchema,
  ContextVisibilityModeSchema,
  DmPolicySchema,
  GroupPolicySchema,
  HumanDelaySchema,
  IdentitySchema,
  MarkdownConfigSchema,
  ReplyToModeSchema,
  TextChunkModeSchema,
  TypingModeSchema,
} from "./zod-schema.core.js";
import type { DiagnosticsConfigSchema, LoggingConfigSchema } from "./zod-schema.logging.js";
import type { SessionSchema } from "./zod-schema.session-config.js";

/** Typing indicator timing policy shared by channel configs. */
export type TypingMode = z.input<typeof TypingModeSchema>;
/** Session-key ownership model for inbound messages. */
export type SessionScope = "per-sender" | "global";
/** DM session-key granularity across peers, channels, and accounts. */
export type DmScope = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
export type GroupScope = "main" | "per-group";
/** Which source messages outbound replies should thread or quote against. */
export type ReplyToMode = z.input<typeof ReplyToModeSchema>;
/** Group-chat admission policy for channels with allowlists. */
export type GroupPolicy = z.input<typeof GroupPolicySchema>;
/** Direct-message admission policy for channels with pairing/allowlists. */
export type DmPolicy = z.input<typeof DmPolicySchema>;
/** How much non-allowlisted context is visible to an agent. */
export type ContextVisibilityMode = z.input<typeof ContextVisibilityModeSchema>;
/** Text splitting strategy for outbound channel delivery. */
export type TextChunkMode = z.input<typeof TextChunkModeSchema>;
/** Preview/progress delivery mode while an agent response is still streaming. */
export type StreamingMode = z.input<typeof UnifiedStreamingModeSchema>;
/** How command text is represented in streaming progress previews. */
export type ChannelStreamingCommandTextMode = NonNullable<
  z.input<typeof ChannelStreamingProgressSchema>["commandText"]
>;

export type BlockStreamingCoalesceConfig = z.input<typeof BlockStreamingCoalesceSchema>;
export type BlockStreamingChunkConfig = z.input<typeof BlockStreamingChunkSchema>;
export type ChannelStreamingProgressConfig = z.input<typeof ChannelStreamingProgressSchema>;
export type ChannelStreamingBlockConfig = z.input<typeof ChannelStreamingBlockSchema>;

type SchemaChannelStreamingConfig = z.input<typeof ChannelPreviewStreamingConfigSchema>;

export type ChannelStreamingConfig<
  TProgress extends ChannelStreamingProgressConfig = ChannelStreamingProgressConfig,
> = Omit<SchemaChannelStreamingConfig, "progress"> & {
  /** Prefer a channel's native streaming transport over its portable draft path. */
  nativeTransport?: boolean;
  progress?: TProgress;
};

export type ChannelDeliveryStreamingConfig = z.input<typeof ChannelDeliveryStreamingConfigSchema>;

/** Streaming subset used by channels that render visible preview/progress replies. */
export type ChannelPreviewStreamingConfig = Pick<
  ChannelStreamingConfig,
  "mode" | "chunkMode" | "preview" | "progress" | "block"
>;

export type MarkdownConfig = NonNullable<z.input<typeof MarkdownConfigSchema>>;
export type MarkdownTableMode = NonNullable<MarkdownConfig["tables"]>;
export type HumanDelayConfig = z.input<typeof HumanDelaySchema>;

type SessionSchemaInput = NonNullable<z.input<typeof SessionSchema>>;

export type SessionResetConfig = NonNullable<SessionSchemaInput["reset"]>;
export type SessionResetMode = NonNullable<SessionResetConfig["mode"]>;

export type SessionThreadBindingsConfig = NonNullable<SessionSchemaInput["threadBindings"]>;

export type SessionConfig = SessionSchemaInput;

export type SessionMaintenanceConfig = NonNullable<SessionSchemaInput["maintenance"]>;
export type SessionMaintenanceMode = NonNullable<SessionMaintenanceConfig["mode"]>;

// Provider docking: allowlists keyed by provider id (and internal "webchat").
export type AgentElevatedAllowFromConfig = Partial<Record<string, Array<string | number>>>;

export type IdentityConfig = NonNullable<z.input<typeof IdentitySchema>>;

export type LoggingConfig = NonNullable<z.input<typeof LoggingConfigSchema>>;

export type DiagnosticsConfig = NonNullable<z.input<typeof DiagnosticsConfigSchema>>;

export type AuditConfig = NonNullable<LoggingConfig["audit"]>;
