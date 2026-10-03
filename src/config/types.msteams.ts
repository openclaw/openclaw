import type { z } from "zod";
import type { MSTeamsConfigSchemaBase } from "../../extensions/msteams/config-schema-api.js";
import type { ChannelPreviewStreamingConfig } from "./types.base.js";
import type {
  ChannelBotInteractionConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";

type MSTeamsSchemaInput = z.input<typeof MSTeamsConfigSchemaBase>;
type MSTeamsSchemaTeam = NonNullable<NonNullable<MSTeamsSchemaInput["teams"]>[string]>;
type MSTeamsSchemaChannel = NonNullable<NonNullable<MSTeamsSchemaTeam["channels"]>[string]>;

export type MSTeamsWebhookConfig = NonNullable<MSTeamsSchemaInput["webhook"]> & {
  /** @deprecated Type-only until the next SDK major; Doctor migrates this to legacyWebhook.port. */
  port?: number;
};
export type MSTeamsCloudName = NonNullable<MSTeamsSchemaInput["cloud"]>;
export type MSTeamsSsoConfig = NonNullable<MSTeamsSchemaInput["sso"]>;
export type MSTeamsReplyStyle = NonNullable<MSTeamsSchemaInput["replyStyle"]>;
export type MSTeamsChannelConfig = Omit<MSTeamsSchemaChannel, "toolsBySender"> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
};
export type MSTeamsTeamConfig = MSTeamsChannelConfig & {
  channels?: Record<string, MSTeamsChannelConfig>;
};

type MSTeamsSharedConfig = Omit<
  CommonChannelMessagingConfig<string[], string, string, ChannelPreviewStreamingConfig>,
  "mentionPatterns" | "name" | "replyToMode"
> &
  Pick<ChannelBotInteractionConfig<boolean>, "dangerouslyAllowNameMatching">;

export type MSTeamsConfig = Omit<
  MSTeamsSchemaInput,
  keyof MSTeamsSharedConfig | "webhook" | "teams"
> &
  MSTeamsSharedConfig & {
    webhook?: MSTeamsWebhookConfig;
    teams?: Record<string, MSTeamsTeamConfig>;
  };
