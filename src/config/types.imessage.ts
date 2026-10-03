/** iMessage account configuration shared by the runtime and Plugin SDK. */
import type { z } from "zod";
import type { IMessageConfigSchema } from "../../extensions/imessage/config-api.js";
import type {
  ChannelReactionConfig,
  ChannelReadReceiptConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";

type IMessageSchemaAccount = NonNullable<
  NonNullable<z.output<typeof IMessageConfigSchema>["accounts"]>[string]
>;
type IMessageSchemaGroup = NonNullable<NonNullable<IMessageSchemaAccount["groups"]>[string]>;

export type IMessageActionConfig = NonNullable<IMessageSchemaAccount["actions"]>;
export type IMessageReactionNotificationMode = NonNullable<
  IMessageSchemaAccount["reactionNotifications"]
>;
export type IMessageSendTransport = NonNullable<IMessageSchemaAccount["sendTransport"]>;

type IMessageSharedConfig = Omit<CommonChannelMessagingConfig, "mentionPatterns" | "replyToMode"> &
  ChannelReadReceiptConfig &
  ChannelReactionConfig<IMessageReactionNotificationMode>;

export type IMessageAccountConfig = Omit<
  IMessageSchemaAccount,
  keyof IMessageSharedConfig | "groups"
> &
  IMessageSharedConfig & {
    groups?: Record<
      string,
      Omit<IMessageSchemaGroup, "toolsBySender"> & {
        toolsBySender?: GroupToolPolicyBySenderConfig;
      }
    >;
  };

export type IMessageConfig = IMessageAccountConfig & {
  accounts?: Record<string, IMessageAccountConfig>;
  defaultAccount?: string;
};
