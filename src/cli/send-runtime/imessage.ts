import { sendMessageIMessage as sendMessageIMessageImpl } from "../../plugin-sdk/imessage.js";

type SendMessageIMessage = typeof import("../../plugin-sdk/imessage.js").sendMessageIMessage;

export async function sendMessageIMessage(
  ...args: Parameters<SendMessageIMessage>
): ReturnType<SendMessageIMessage> {
  return await sendMessageIMessageImpl(...args);
}
