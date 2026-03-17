import { sendMessageWhatsApp as sendMessageWhatsAppImpl } from "../../plugin-sdk/whatsapp.js";

type SendMessageWhatsApp = typeof import("../../plugin-sdk/whatsapp.js").sendMessageWhatsApp;

export async function sendMessageWhatsApp(
  ...args: Parameters<SendMessageWhatsApp>
): ReturnType<SendMessageWhatsApp> {
  return await sendMessageWhatsAppImpl(...args);
}
