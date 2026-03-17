import {
  sendMessageWhatsApp as sendMessageWhatsAppImpl,
  sendPollWhatsApp as sendPollWhatsAppImpl,
} from "../../../extensions/whatsapp/src/send.js";

type SendMessageWhatsApp =
  typeof import("../../../extensions/whatsapp/src/send.js").sendMessageWhatsApp;
type SendPollWhatsApp = typeof import("../../../extensions/whatsapp/src/send.js").sendPollWhatsApp;

export function sendMessageWhatsApp(
  ...args: Parameters<SendMessageWhatsApp>
): ReturnType<SendMessageWhatsApp> {
  return sendMessageWhatsAppImpl(...args);
}

export function sendPollWhatsApp(
  ...args: Parameters<SendPollWhatsApp>
): ReturnType<SendPollWhatsApp> {
  return sendPollWhatsAppImpl(...args);
}
