import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

type SendFn = (...args: unknown[]) => unknown;

export type CliDeps = {
  sendMessageWhatsApp: SendFn;
  sendMessageTelegram: SendFn;
  sendMessageDiscord: SendFn;
  sendMessageSlack: SendFn;
  sendMessageSignal: SendFn;
  sendMessageIMessage: SendFn;
};

export function createDefaultDeps(): CliDeps {
  const noopSend: SendFn = async () => ({ messageId: "", timestamp: 0 });
  return {
    sendMessageWhatsApp: noopSend,
    sendMessageTelegram: noopSend,
    sendMessageDiscord: noopSend,
    sendMessageSlack: noopSend,
    sendMessageSignal: noopSend,
    sendMessageIMessage: noopSend,
  };
}

// Provider docking: extend this mapping when adding new outbound send deps.
export function createOutboundSendDeps(deps: CliDeps): OutboundSendDeps {
  return {
    sendWhatsApp: deps.sendMessageWhatsApp,
    sendTelegram: deps.sendMessageTelegram,
    sendDiscord: deps.sendMessageDiscord,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
  };
}

export function logWebSelfId(..._args: unknown[]): void {
  // Stub: web auth store removed with channel integrations.
}
