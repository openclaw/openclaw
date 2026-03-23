import { sendMessageTelegram as sendMessageTelegramImpl } from "../../../extensions/telegram/runtime-api.js";

type RuntimeSend = {
  sendMessage: typeof import("../../../extensions/telegram/runtime-api.js").sendMessageTelegram;
};

export const runtimeSend = {
  sendMessage: sendMessageTelegramImpl,
} satisfies RuntimeSend;
