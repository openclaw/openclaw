import { sendMessageDiscord as sendMessageDiscordImpl } from "openclaw/plugin-sdk/discord";

type RuntimeSend = {
  sendMessage: typeof import("openclaw/plugin-sdk/discord").sendMessageDiscord;
};

export const runtimeSend = {
  sendMessage: sendMessageDiscordImpl,
} satisfies RuntimeSend;
