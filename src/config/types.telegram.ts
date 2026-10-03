import type { z } from "zod";
import type { TelegramAccountSchemaBase } from "../../extensions/telegram/config-schema-api.js";
import type {
  ChannelExecApprovalConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { SecretInput } from "./types.secrets.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";

type TelegramSchemaAccount = z.input<typeof TelegramAccountSchemaBase>;
type TelegramSchemaGroup = NonNullable<NonNullable<TelegramSchemaAccount["groups"]>[string]>;
type TelegramSchemaDirect = NonNullable<NonNullable<TelegramSchemaAccount["direct"]>[string]>;

export type TelegramActionConfig = NonNullable<TelegramSchemaAccount["actions"]>;
export type TelegramThreadBindingsConfig = NonNullable<TelegramSchemaAccount["threadBindings"]>;
export type TelegramNetworkConfig = NonNullable<TelegramSchemaAccount["network"]>;
export type TelegramCapabilitiesConfig = NonNullable<TelegramSchemaAccount["capabilities"]>;
export type TelegramInlineButtonsScope = NonNullable<
  Exclude<TelegramCapabilitiesConfig, string[]>["inlineButtons"]
>;
export type TelegramPreviewStreamingConfig = NonNullable<TelegramSchemaAccount["streaming"]>;
export type TelegramExecApprovalConfig = ChannelExecApprovalConfig;
export type TelegramCustomCommand = NonNullable<TelegramSchemaAccount["customCommands"]>[number];
export type TelegramTopicConfig = NonNullable<NonNullable<TelegramSchemaGroup["topics"]>[string]>;
export type TelegramGroupConfig = Omit<TelegramSchemaGroup, "toolsBySender" | "topics"> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
  topics?: Record<string, TelegramTopicConfig>;
};
export type AutoTopicLabelConfig = NonNullable<TelegramSchemaAccount["autoTopicLabel"]>;
export type TelegramDirectConfig = Omit<TelegramSchemaDirect, "toolsBySender" | "topics"> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
  topics?: Record<string, Omit<TelegramTopicConfig, "requireMentionInBotThreads">>;
};

export type TelegramAccountConfig = Omit<
  TelegramSchemaAccount,
  "dms" | "groups" | "direct" | "webhookSecret" | "execApprovals" | "botToken"
> &
  Pick<CommonChannelMessagingConfig, "dms" | "heartbeat"> & {
    groups?: Record<string, TelegramGroupConfig>;
    direct?: Record<string, TelegramDirectConfig>;
    webhookSecret?: string;
    botToken?: SecretInput;
    execApprovals?: TelegramExecApprovalConfig;
    /** @deprecated Legacy input only; Doctor migrates this to legacyWebhook.host. */
    webhookHost?: string;
    /** @deprecated Legacy input only; Doctor migrates this to legacyWebhook.port. */
    webhookPort?: number;
  };

export type TelegramConfig = TelegramAccountConfig & {
  accounts?: Record<string, TelegramAccountConfig>;
  defaultAccount?: string;
};
