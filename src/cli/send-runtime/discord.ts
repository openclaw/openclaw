import { createChannelOutboundRuntimeSend } from "./channel-outbound-send.js";

export const runtimeSend = createChannelOutboundRuntimeSend({
  channelId: "discord",
  unavailableMessage: "Discord outbound adapter is unavailable.",
});
