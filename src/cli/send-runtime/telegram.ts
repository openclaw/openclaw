import { sendMessageTelegram as sendMessageTelegramImpl } from "../../plugin-sdk/telegram.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugin-sdk/telegram.js").sendMessageTelegram;
};

export const runtimeSend = {
  sendMessage: sendMessageTelegramImpl,
} satisfies RuntimeSend;
