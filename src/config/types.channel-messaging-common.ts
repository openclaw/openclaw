import type { z } from "zod";
import type { ChannelGroupEntrySchema } from "../channels/plugins/config-schema.js";
import type { NativeExecApprovalEnableMode } from "./types.approvals.js";
import type { ChannelDeliveryStreamingConfig } from "./types.base.js";
import type { ChannelBotLoopProtectionConfig } from "./types.bot-loop-protection.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channel-health.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";
import type { CommonChannelAccountSchema } from "./zod-schema.channel-messaging-common.js";

type SchemaCommonChannelMessagingConfig = z.input<typeof CommonChannelAccountSchema>;

export type CommonChannelGroupConfig = Omit<
  z.input<typeof ChannelGroupEntrySchema>,
  "toolsBySender"
> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type CommonChannelMessagingConfig<
  TCapabilities = string[],
  TAllowFromEntry = string | number,
  TDefaultTo = string,
  TStreaming = ChannelDeliveryStreamingConfig,
> = Omit<
  SchemaCommonChannelMessagingConfig,
  "capabilities" | "allowFrom" | "defaultTo" | "groupAllowFrom" | "dms" | "streaming"
> & {
  capabilities?: TCapabilities;
  allowFrom?: TAllowFromEntry[];
  defaultTo?: TDefaultTo;
  groupAllowFrom?: TAllowFromEntry[];
  dms?: Record<string, DmConfig>;
  streaming?: TStreaming;
  /** @deprecated Doctor-only legacy input. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
};

export type ChannelExecApprovalConfig<TApprover = string | number> = {
  enabled?: NativeExecApprovalEnableMode;
  approvers?: TApprover[];
  agentFilter?: string[];
  sessionFilter?: string[];
  target?: "dm" | "channel" | "both";
};

export type ChannelBotInteractionConfig<TAllowBots = boolean | "mentions"> = {
  allowBots?: TAllowBots;
  botLoopProtection?: ChannelBotLoopProtectionConfig;
  dangerouslyAllowNameMatching?: boolean;
};

export type ChannelReadReceiptConfig = {
  sendReadReceipts?: boolean;
};

export type ChannelReactionConfig<
  TNotification = never,
  TLevel = never,
  TAckReaction = never,
  TAllowlist extends boolean = false,
> = {
  reactionNotifications?: TNotification;
  reactionLevel?: TLevel;
  ackReaction?: TAckReaction;
} & (TAllowlist extends true
  ? { reactionAllowlist?: Array<string | number> }
  : Record<never, never>);
