import { sendMessageWhatsApp as sendMessageWhatsAppImpl } from "../../plugins/runtime/runtime-whatsapp-boundary.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugins/runtime/runtime-whatsapp-boundary.js").sendMessageWhatsApp;
};

export const runtimeSend = {
  sendMessage: sendMessageWhatsAppImpl,
} satisfies RuntimeSend;
