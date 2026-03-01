import type { ChannelPlugin } from "../channels/plugins/types.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import type { MessageTracker } from "./message-tracker.js";
import type { SimOutboundMessage } from "./types.js";
import { uuidv7 } from "./uuidv7.js";

/**
 * Create a fake channel plugin for simulations.
 * Composes on `createChannelTestPluginBase()` for required meta fields,
 * then overrides `outbound.sendText` to capture replies into the tracker.
 */
export function createFakeChannelPlugin(params: {
  channelType: string;
  tracker: MessageTracker;
  onOutbound?: (msg: SimOutboundMessage) => void;
}): ChannelPlugin {
  const base = createChannelTestPluginBase({
    id: params.channelType,
    label: `sim-${params.channelType}`,
    capabilities: { chatTypes: ["direct", "group"] },
  });

  return {
    ...base,
    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx) => {
        const msg: Omit<SimOutboundMessage, "seq"> = {
          id: uuidv7(),
          ts: Date.now(),
          direction: "outbound",
          conversationId: ctx.to,
          agentId: "unknown",
          text: ctx.text,
          causalParentId: "",
          causalParentTs: 0,
        };
        const recorded = params.tracker.record(msg) as SimOutboundMessage;
        params.onOutbound?.(recorded);
        return { channel: params.channelType, messageId: recorded.id };
      },
    },
  };
}
