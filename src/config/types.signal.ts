import type { z } from "zod";
import type { SignalAccountSchemaBase } from "../../extensions/signal/config-schema-api.js";
import type {
  ChannelReactionConfig,
  ChannelReadReceiptConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";

type SignalSchemaAccount = z.output<typeof SignalAccountSchemaBase>;
type SignalSchemaGroup = NonNullable<NonNullable<SignalSchemaAccount["groups"]>[string]>;

export type SignalReactionNotificationMode = NonNullable<
  SignalSchemaAccount["reactionNotifications"]
>;
export type SignalReactionLevel = NonNullable<SignalSchemaAccount["reactionLevel"]>;
export type SignalTransportConfig = NonNullable<SignalSchemaAccount["transport"]>;
export type SignalGroupConfig = Omit<SignalSchemaGroup, "toolsBySender"> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

type SignalSharedConfig = Omit<CommonChannelMessagingConfig, "mentionPatterns"> &
  ChannelReadReceiptConfig &
  ChannelReactionConfig<SignalReactionNotificationMode, SignalReactionLevel, never, true>;

export type SignalAccountConfig = Omit<SignalSchemaAccount, keyof SignalSharedConfig | "groups"> &
  SignalSharedConfig & {
    groups?: Record<string, SignalGroupConfig>;
  };

export type SignalConfig = SignalAccountConfig & {
  accounts?: Record<string, SignalAccountConfig>;
  defaultAccount?: string;
};
