import { sendMessageTelegram as sendMessageTelegramImpl } from "openclaw/plugin-sdk/telegram";

type RuntimeSend = {
  sendMessage: typeof import("openclaw/plugin-sdk/telegram").sendMessageTelegram;
};

export const runtimeSend = {
  sendMessage: sendMessageTelegramImpl,
} satisfies RuntimeSend;
