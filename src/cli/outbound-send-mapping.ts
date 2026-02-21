import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

export type CliOutboundSendSource = {
  sendMessageWhatsApp: OutboundSendDeps["sendWhatsApp"];
  sendMessageTelegram: OutboundSendDeps["sendTelegram"];
  sendMessageDiscord: OutboundSendDeps["sendDiscord"];
  sendMessageSlack: OutboundSendDeps["sendSlack"];
  sendMessageSignal: OutboundSendDeps["sendSignal"];
  sendMessageIMessage: OutboundSendDeps["sendIMessage"];
};

// Provider docking: extend this mapping when adding new outbound send deps.
export function createOutboundSendDepsFromCliSource(deps: CliOutboundSendSource): OutboundSendDeps {
  return {
    sendWhatsApp: deps.sendMessageWhatsApp,
    sendTelegram: deps.sendMessageTelegram,
    sendDiscord: deps.sendMessageDiscord,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
  };
}
