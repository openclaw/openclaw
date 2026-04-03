import { createChannelOutboundRuntimeSend } from "./channel-outbound-send.js";

export const runtimeSend = createChannelOutboundRuntimeSend({
  channelId: "whatsapp",
  unavailableMessage: "WhatsApp outbound adapter is unavailable.",
});
