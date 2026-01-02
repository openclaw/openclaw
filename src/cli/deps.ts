import { sendMessageDiscord } from "../discord/send.js";
import { sendMessageIMessage } from "../imessage/send.js";
import { logWebSelfId, sendMessageWhatsApp } from "../providers/web/index.js";
import { sendMessageSignal } from "../signal/send.js";
import { sendMessageTelegram } from "../telegram/send.js";

export type CliDeps = {
  sendMessageWhatsApp: typeof sendMessageWhatsApp;
  sendMessageTelegram: typeof sendMessageTelegram;
  sendMessageDiscord: typeof sendMessageDiscord;
  sendMessageSignal: typeof sendMessageSignal;
  sendMessageIMessage: typeof sendMessageIMessage;
};

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageWhatsApp,
    sendMessageTelegram,
    sendMessageDiscord,
    sendMessageSignal,
    sendMessageIMessage,
  };
}

export { logWebSelfId };
