import type { z } from "zod";
import type { SlackConfigSchema } from "../../extensions/slack/config-api.js";
import type {
  ChannelBotInteractionConfig,
  ChannelExecApprovalConfig,
  ChannelReactionConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";

type SlackSchemaAccount = NonNullable<
  NonNullable<z.output<typeof SlackConfigSchema>["accounts"]>[string]
>;
type SlackSchemaChannel = NonNullable<NonNullable<SlackSchemaAccount["channels"]>[string]>;

export type SlackDmConfig = NonNullable<SlackSchemaAccount["dm"]>;
export type SlackChannelConfig = Omit<SlackSchemaChannel, "toolsBySender"> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
};
export type SlackReactionNotificationMode = NonNullable<
  SlackSchemaAccount["reactionNotifications"]
>;
// DO NOT REMOVE OR CHANGE THE COMPACT STYLE WITHOUT APPROVAL FROM SJF OR PASHPASHPASH.
export type SlackStreamingProgressConfig = NonNullable<SlackChannelStreamingConfig["progress"]>;
export type SlackChannelStreamingConfig = NonNullable<SlackSchemaAccount["streaming"]>;
export type SlackExecApprovalConfig = ChannelExecApprovalConfig;
export type SlackCapabilitiesConfig = NonNullable<SlackSchemaAccount["capabilities"]>;
export type SlackActionConfig = NonNullable<SlackSchemaAccount["actions"]>;
export type SlackSlashCommandConfig = NonNullable<SlackSchemaAccount["slashCommand"]>;
export type SlackThreadConfig = NonNullable<SlackSchemaAccount["thread"]>;
export type SlackRelayConfig = NonNullable<SlackSchemaAccount["relay"]>;

type SlackSharedConfig = Omit<
  CommonChannelMessagingConfig<
    SlackCapabilitiesConfig,
    string | number,
    string,
    SlackChannelStreamingConfig
  >,
  "groupAllowFrom"
> &
  ChannelBotInteractionConfig &
  ChannelReactionConfig<SlackReactionNotificationMode, never, string, true>;

export type SlackAccountConfig = Omit<
  SlackSchemaAccount,
  keyof SlackSharedConfig | "channels" | "execApprovals"
> &
  SlackSharedConfig & {
    /** @deprecated Doctor-only legacy input. */
    identity?: "bot" | "user";
    /** @deprecated Doctor-only legacy input. */
    socketMode?: {
      clientPingTimeout?: number;
      serverPingTimeout?: number;
      pingPongLoggingEnabled?: boolean;
    };
    execApprovals?: SlackExecApprovalConfig;
    channels?: Record<string, SlackChannelConfig>;
  };

export type SlackConfig = SlackAccountConfig & {
  accounts?: Record<string, SlackAccountConfig>;
  defaultAccount?: string;
};
