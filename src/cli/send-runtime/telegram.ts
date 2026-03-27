import { sendMessageTelegram as sendMessageTelegramImpl } from "../../plugin-sdk/telegram-runtime.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugin-sdk/telegram-runtime.js").sendMessageTelegram;
};

export const runtimeSend = {
  sendMessage: sendMessageTelegramImpl,
} satisfies RuntimeSend;
