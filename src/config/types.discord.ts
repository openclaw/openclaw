import type { z } from "zod";
import type { DiscordAccountSchemaBase } from "../../extensions/discord/config-schema-api.js";
import type {
  ChannelExecApprovalConfig,
  ChannelReactionConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { SecretInput } from "./types.secrets.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";

// Runtime Discord config carries normalized string IDs.
type DiscordSchemaAccount = z.output<typeof DiscordAccountSchemaBase>;
type DiscordSchemaGuild = NonNullable<NonNullable<DiscordSchemaAccount["guilds"]>[string]>;
type DiscordSchemaGuildChannel = NonNullable<NonNullable<DiscordSchemaGuild["channels"]>[string]>;
type DiscordSchemaVoice = NonNullable<DiscordSchemaAccount["voice"]>;

export type DiscordChannelStreamingConfig = NonNullable<DiscordSchemaAccount["streaming"]>;
export type DiscordPluralKitConfig = Omit<
  NonNullable<DiscordSchemaAccount["pluralkit"]>,
  "token"
> & {
  token?: string;
};
export type DiscordMentionAliasesConfig = NonNullable<DiscordSchemaAccount["mentionAliases"]>;
export type DiscordDmConfig = NonNullable<DiscordSchemaAccount["dm"]>;
export type DiscordGuildChannelConfig = Omit<DiscordSchemaGuildChannel, "toolsBySender"> & {
  /** If true, automatically create a thread for each new message in this channel. */
  autoThread?: boolean;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};
export type DiscordReactionNotificationMode = NonNullable<
  DiscordSchemaGuild["reactionNotifications"]
>;
export type DiscordGuildEntry = Omit<DiscordSchemaGuild, "toolsBySender" | "channels"> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
  channels?: Record<string, DiscordGuildChannelConfig>;
};
export type DiscordActionConfig = NonNullable<DiscordSchemaAccount["actions"]>;
export type DiscordIntentsConfig = NonNullable<DiscordSchemaAccount["intents"]>;
export type DiscordVoiceAutoJoinConfig = NonNullable<DiscordSchemaVoice["autoJoin"]>[number];
export type DiscordVoiceAllowedChannelConfig = NonNullable<
  DiscordSchemaVoice["allowedChannels"]
>[number];
export type DiscordVoiceMode = NonNullable<DiscordSchemaVoice["mode"]>;
export type DiscordVoiceRealtimeConfig = NonNullable<DiscordSchemaVoice["realtime"]>;
export type DiscordVoiceRealtimeConsultPolicy = NonNullable<
  DiscordVoiceRealtimeConfig["consultPolicy"]
>;
export type DiscordVoiceRealtimeToolPolicy = NonNullable<DiscordVoiceRealtimeConfig["toolPolicy"]>;
export type DiscordVoiceRealtimeBootstrapContextFile = NonNullable<
  DiscordVoiceRealtimeConfig["bootstrapContextFiles"]
>[number];
export type DiscordVoiceAgentSessionConfig = NonNullable<DiscordSchemaVoice["agentSession"]>;
export type DiscordVoiceConfig = Omit<DiscordSchemaVoice, "tts"> & { tts?: TtsConfig };

export type DiscordExecApprovalConfig = ChannelExecApprovalConfig<string> & {
  /** Delete approval DMs after approval, denial, or timeout. Default: false. */
  cleanupAfterResolve?: boolean;
};
export type DiscordAgentComponentsConfig = NonNullable<DiscordSchemaAccount["agentComponents"]>;
export type DiscordThreadBindingsConfig = NonNullable<DiscordSchemaAccount["threadBindings"]>;
export type DiscordSlashCommandConfig = NonNullable<DiscordSchemaAccount["slashCommand"]>;
export type DiscordThreadConfig = NonNullable<DiscordSchemaAccount["thread"]>;
export type DiscordAutoPresenceConfig = NonNullable<DiscordSchemaAccount["autoPresence"]> & {
  /** @deprecated Doctor-only legacy input. */
  exhaustedText?: string;
};

export type DiscordAccountConfig = Omit<
  DiscordSchemaAccount,
  "dms" | "guilds" | "voice" | "pluralkit" | "autoPresence" | "execApprovals" | "token"
> &
  Pick<CommonChannelMessagingConfig, "dms" | "heartbeat"> &
  ChannelReactionConfig<never, never, string> & {
    guilds?: Record<string, DiscordGuildEntry>;
    voice?: DiscordVoiceConfig;
    pluralkit?: DiscordPluralKitConfig;
    autoPresence?: DiscordAutoPresenceConfig;
    execApprovals?: DiscordExecApprovalConfig;
    token?: SecretInput;
  };

export type DiscordConfig = DiscordAccountConfig & {
  accounts?: Record<string, DiscordAccountConfig>;
  defaultAccount?: string;
};
