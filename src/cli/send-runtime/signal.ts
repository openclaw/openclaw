import { createChannelOutboundRuntimeSend } from "./channel-outbound-send.js";

export const runtimeSend = createChannelOutboundRuntimeSend({
  channelId: "signal",
  unavailableMessage: "Signal outbound adapter is unavailable.",
});
