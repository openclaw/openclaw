import type { IrcAccountConfigInput } from "../../extensions/irc/channel-config-api.js";
import type { CommonChannelMessagingConfig } from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";

type IrcSchemaGroup = NonNullable<NonNullable<IrcAccountConfigInput["groups"]>[string]>;
type IrcSharedConfig = Omit<CommonChannelMessagingConfig, "mentionPatterns">;

export type IrcAccountConfig = Omit<
  IrcAccountConfigInput,
  keyof IrcSharedConfig | "groups" | "dangerouslyAllowNameMatching"
> &
  IrcSharedConfig & {
    groups?: Record<
      string,
      Omit<IrcSchemaGroup, "toolsBySender"> & {
        toolsBySender?: GroupToolPolicyBySenderConfig;
      }
    >;
  };

export type IrcConfig = IrcAccountConfig & {
  accounts?: Record<string, IrcAccountConfig>;
  defaultAccount?: string;
};
