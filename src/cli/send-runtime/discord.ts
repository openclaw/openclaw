import { sendMessageDiscord as sendMessageDiscordImpl } from "../../plugin-sdk/discord.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugin-sdk/discord.js").sendMessageDiscord;
};

export const runtimeSend = {
  sendMessage: sendMessageDiscordImpl,
} satisfies RuntimeSend;
