import { createChannelOutboundRuntimeSend } from "./channel-outbound-send.js";

export const runtimeSend = createChannelOutboundRuntimeSend({
  channelId: "slack",
  unavailableMessage: "Slack outbound adapter is unavailable.",
});
