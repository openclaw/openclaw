import { sendMessageWhatsApp as sendMessageWhatsAppImpl } from "../../plugins/runtime/runtime-web-channel-boundary.js";

type RuntimeSend = {
  sendMessage: typeof import("../../plugins/runtime/runtime-web-channel-boundary.js").sendMessageWhatsApp;
};

export const runtimeSend = {
  sendMessage: sendMessageWhatsAppImpl,
} satisfies RuntimeSend;
