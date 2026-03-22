import { sendMessageWhatsApp as sendMessageWhatsAppImpl } from "../../plugin-sdk/whatsapp.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugin-sdk/whatsapp.js").sendMessageWhatsApp;
};

export const runtimeSend = {
  sendMessage: sendMessageWhatsAppImpl,
} satisfies RuntimeSend;
