import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatInputDelivery = {
  chat: {
    messages: {
      inputDeliveryRead: "Read",
      inputDeliveryReadDescription:
        "Delivered to the agent’s active context. This does not confirm that it followed the instruction.",
      inputDeliveryUnconfirmed: "Delivery unconfirmed",
      inputDeliveryUnconfirmedDescription:
        "The agent may have received this message, but delivery could not be confirmed. Do not resend it automatically.",
      inputDeliveryNotSteered: "Not read by active run",
      inputDeliveryNotSteeredDescription:
        "This message did not reach the active run. It may still be queued for a later turn.",
    },
  },
} satisfies TranslationMap;

export const registerChatInputDeliveryEnglish = Object.assign(
  () => {
    Object.assign(en.chat.messages, enChatInputDelivery.chat.messages);
  },
  { catalog: enChatInputDelivery },
);
