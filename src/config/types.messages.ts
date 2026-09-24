// Defines message queue and delivery configuration types.
import type { z } from "zod";
import type {
  BroadcastSchema,
  DmConfigSchema,
  GroupChatSchema,
  InboundDebounceSchema,
  MentionPatternsPolicySchema,
  MessagesSchema,
  ProviderCommandsSchema,
  QueueSchema,
} from "./zod-schema.messages.js";

type DefinedSchemaInput<T extends z.ZodType> = NonNullable<z.input<T>>;

export type MentionPatternsPolicyConfig = DefinedSchemaInput<typeof MentionPatternsPolicySchema>;
export type MentionPatternsMode = NonNullable<MentionPatternsPolicyConfig["mode"]>;

type GroupChatSchemaInput = DefinedSchemaInput<typeof GroupChatSchema>;

export type GroupChatConfig = Omit<GroupChatSchemaInput, "visibleReplies"> & {
  visibleReplies?: "automatic" | "message_tool";
};

export type DmConfig = DefinedSchemaInput<typeof DmConfigSchema>;
export type QueueConfig = DefinedSchemaInput<typeof QueueSchema>;
export type InboundDebounceConfig = DefinedSchemaInput<typeof InboundDebounceSchema>;
export type InboundDebounceByProvider = NonNullable<InboundDebounceConfig["byChannel"]>;

export type BroadcastGroupConfig = Exclude<
  DefinedSchemaInput<typeof BroadcastSchema>[string],
  string[]
>;

export type BroadcastEntry = string[] | BroadcastGroupConfig;

export type BroadcastStrategy = NonNullable<DefinedSchemaInput<typeof BroadcastSchema>["strategy"]>;
export type BroadcastConfig = {
  strategy?: BroadcastStrategy;
  /**
   * Map channel-qualified peer IDs to participant arrays or bounded group options.
   * Unqualified WhatsApp peer arrays retain single-pass behavior.
   *
   * Note: the index signature includes `undefined` so `strategy?: ...` remains type-safe.
   */
  [peerId: string]: BroadcastEntry | BroadcastStrategy | undefined;
};

type MessagesSchemaInput = DefinedSchemaInput<typeof MessagesSchema>;

export type MessagesConfig = Omit<MessagesSchemaInput, "groupChat" | "visibleReplies"> & {
  /** @deprecated Doctor-only legacy input. */
  removeAckAfterReply?: boolean;
  visibleReplies?: "automatic" | "message_tool";
  groupChat?: GroupChatConfig;
};

export type StatusReactionsConfig = NonNullable<MessagesConfig["statusReactions"]>;

export type NativeCommandsSetting = boolean | "auto";

export type CommandAllowFrom = Record<string, Array<string | number>>;

export type CommandsConfig = {
  /** @deprecated Doctor-only legacy input. */
  ownerDisplay?: "raw" | "hash";
  /** @deprecated Doctor-only legacy input. */
  ownerDisplaySecret?: string;
  native?: NativeCommandsSetting;
  nativeSkills?: NativeCommandsSetting;
  text?: boolean;
  bash?: boolean;
  bashForegroundMs?: number;
  config?: boolean;
  mcp?: boolean;
  plugins?: boolean;
  debug?: boolean;
  restart?: boolean;
  ownerAllowFrom?: Array<string | number>;
  allowFrom?: CommandAllowFrom;
};

export type ProviderCommandsConfig = DefinedSchemaInput<typeof ProviderCommandsSchema>;
