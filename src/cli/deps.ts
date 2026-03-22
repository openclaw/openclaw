import type { sendMessageTelegram } from "../telegram/send.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

export type CliDeps = {
  sendMessageTelegram: typeof sendMessageTelegram;
};

let telegramSenderRuntimePromise: Promise<typeof import("./deps-send-telegram.runtime.js")> | null =
  null;

function loadTelegramSenderRuntime() {
  telegramSenderRuntimePromise ??= import("./deps-send-telegram.runtime.js");
  return telegramSenderRuntimePromise;
}

export function createDefaultDeps(): CliDeps {
  return {
    sendMessageTelegram: async (...args) => {
      const { sendMessageTelegram } = await loadTelegramSenderRuntime();
      return await sendMessageTelegram(...args);
    },
  };
}

export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return createOutboundSendDepsFromCliSource(deps);
}
