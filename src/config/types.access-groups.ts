// Defines access-group config types for channel audiences.
import type { z } from "zod";
import type { AccessGroupsSchema } from "./zod-schema.root-support.js";

export type AccessGroupsConfig = NonNullable<z.input<typeof AccessGroupsSchema>>;
export type AccessGroupConfig = AccessGroupsConfig[string];
export type DiscordChannelAudienceAccessGroup = Extract<
  AccessGroupConfig,
  { type: "discord.channelAudience" }
>;
export type MessageSendersAccessGroup = Extract<AccessGroupConfig, { type: "message.senders" }>;
