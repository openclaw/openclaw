import { sendMessageTelegram as sendMessageTelegramImpl } from "../../plugin-sdk/telegram.js";

type SendMessageTelegram = typeof import("../../plugin-sdk/telegram.js").sendMessageTelegram;

export async function sendMessageTelegram(
  ...args: Parameters<SendMessageTelegram>
): ReturnType<SendMessageTelegram> {
  return await sendMessageTelegramImpl(...args);
}
