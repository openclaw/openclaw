import {
  sendMessageWhatsApp as sendMessageWhatsAppImpl,
  sendPollWhatsApp as sendPollWhatsAppImpl,
} from "openclaw/plugin-sdk/whatsapp";
import type { PluginRuntime } from "./types.js";

type RuntimeWhatsAppOutbound = Pick<
  PluginRuntime["channel"]["whatsapp"],
  "sendMessageWhatsApp" | "sendPollWhatsApp"
>;

export const runtimeWhatsAppOutbound = {
  sendMessageWhatsApp: sendMessageWhatsAppImpl,
  sendPollWhatsApp: sendPollWhatsAppImpl,
} satisfies RuntimeWhatsAppOutbound;
