export type DiscordChannelAudienceAccessGroup = {
  /**
   * Discord dynamic audience backed by the users who can currently view a guild
   * channel.
   */
  type: "discord.channelAudience";
  /** Guild ID that owns the channel. */
  guildId: string;
  /** Channel ID whose effective ViewChannel permission defines the audience. */
  channelId: string;
  /** Audience predicate. Defaults to canViewChannel. */
  membership?: "canViewChannel";
};

export type AccessGroupConfig = DiscordChannelAudienceAccessGroup;

export type AccessGroupsConfig = Record<string, AccessGroupConfig>;
