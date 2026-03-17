import { sendMessageDiscord as sendMessageDiscordImpl } from "../../plugin-sdk/discord.js";

type SendMessageDiscord = typeof import("../../plugin-sdk/discord.js").sendMessageDiscord;

export async function sendMessageDiscord(
  ...args: Parameters<SendMessageDiscord>
): ReturnType<SendMessageDiscord> {
  return await sendMessageDiscordImpl(...args);
}
