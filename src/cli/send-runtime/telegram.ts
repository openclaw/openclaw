import { createChannelOutboundRuntimeSend } from "./channel-outbound-send.js";

export const runtimeSend = createChannelOutboundRuntimeSend({
  channelId: "telegram",
  unavailableMessage: "Telegram outbound adapter is unavailable.",
});
