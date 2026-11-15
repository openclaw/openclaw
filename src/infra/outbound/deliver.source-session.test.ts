import { expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { prepareOutboundPayloadBatch } from "./deliver-prepare.js";

it.each(["outbound", "message"] as const)(
  "carries the originating session into %s adapters instead of the destination policy session",
  async (surface) => {
    const sendText = vi.fn(async (_ctx: Pick<ChannelMessageSendTextContext, "sessionKey">) => ({
      channel: "source-session" as const,
      messageId: "result-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "source-session", messageId: "result-1" }],
        kind: "text",
      }),
    }));
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "source-session" }),
      ...(surface === "outbound"
        ? { outbound: { deliveryMode: "direct", sendText } }
        : { message: { id: "source-session", send: { text: sendText } } }),
    };
    const registry = createTestRegistry([{ pluginId: plugin.id, plugin, source: "test" }]);
    await withPluginRuntimeRegistryScope(registry, async () => {
      const params = {
        cfg: {},
        channel: plugin.id,
        to: "test-recipient",
        payloads: [{ text: "result" }],
        session: { key: "agent:main:origin", policyKey: "agent:main:destination" },
      };
      const preparedBatch = await prepareOutboundPayloadBatch(params, {
        hookRunner: createHookRunner(registry),
      });
      const results = await deliverOutboundPayloadsCore({ ...params, preparedBatch });
      expect(results.map((result) => result.messageId)).toEqual(["result-1"]);
      expect(sendText).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionKey: "agent:main:origin", text: "result" }),
      );
    });
  },
);
