import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type DiscordApiV10 = typeof import("discord-api-types/v10");
const discordApiV10 = require("discord-api-types/v10") as DiscordApiV10;

export const ApplicationCommandOptionType = discordApiV10.ApplicationCommandOptionType;
export const ButtonStyle = discordApiV10.ButtonStyle;
export const ChannelType = discordApiV10.ChannelType;
export const MessageFlags = discordApiV10.MessageFlags;
export const PollLayoutType = discordApiV10.PollLayoutType;
export const PermissionFlagsBits = discordApiV10.PermissionFlagsBits;
export const Routes = discordApiV10.Routes;
export const StickerFormatType = discordApiV10.StickerFormatType;
export const TextInputStyle = discordApiV10.TextInputStyle;

// Type-only re-export so existing imports can keep using a single module path.
export type * from "discord-api-types/v10";
