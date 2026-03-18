import { sendMessageWhatsApp as sendMessageWhatsAppImpl } from "openclaw/plugin-sdk/whatsapp";

type RuntimeSend = {
  sendMessage: typeof import("openclaw/plugin-sdk/whatsapp").sendMessageWhatsApp;
};

export const runtimeSend = {
  sendMessage: sendMessageWhatsAppImpl,
} satisfies RuntimeSend;
