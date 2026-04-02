import { sendMessageDiscord as sendMessageDiscordImpl } from "../../plugin-sdk/discord-runtime-surface.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugin-sdk/discord-runtime-surface.js").sendMessageDiscord;
};

export const runtimeSend = {
  sendMessage: sendMessageDiscordImpl,
} satisfies RuntimeSend;
