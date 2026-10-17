import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";

export function matrixDeliveryResult(messageId: string, kind: "text" | "media" = "text") {
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "matrix", messageId }],
      kind,
    }),
  };
}

export function installQueueTestPlugin(overrides: Partial<ChannelPlugin> = {}) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
          ...overrides,
        },
      },
    ]),
  );
}
