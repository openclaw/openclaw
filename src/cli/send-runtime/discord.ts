import { sendMessageDiscord as sendMessageDiscordImpl } from "../../../extensions/discord/runtime-api.js";

type RuntimeSend = {
  sendMessage: typeof import("../../../extensions/discord/runtime-api.js").sendMessageDiscord;
};

export const runtimeSend = {
  sendMessage: sendMessageDiscordImpl,
} satisfies RuntimeSend;
