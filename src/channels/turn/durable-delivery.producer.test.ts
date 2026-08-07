// Producer-boundary integration test for #119169: drives the REAL durable-send
// producer (sendDurableMessageBatch -> deliverOutboundPayloadsInternal/deliverCore)
// with a real channel adapter that returns no identity, and asserts the outcome
// reaches settlement as potentially visible (handled_visible). Unlike the unit
// tests in durable-delivery.test.ts, sendDurableMessageBatch is NOT mocked here;
// only the channel adapter is a fixture, which is the legitimate platform boundary.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import type { ChannelOutboundAdapter } from "../plugins/types.public.js";
import { deliverInboundReplyWithMessageSendContext } from "./durable-delivery.js";

const matrixPluginId = "matrix";

function ctxPayload() {
  return {
    CommandAuthorized: true,
    CommandTurn: { kind: "normal", source: "message", authorized: false },
  } as Parameters<typeof deliverInboundReplyWithMessageSendContext>[0]["ctxPayload"];
}

describe("durable inbound reply delivery — real producer boundary (#119169)", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  beforeEach(() => {
    // Adapter was invoked but returned no identity (empty messageId): the
    // platform may have delivered. sendTextOnlyErrorPayloads routes error
    // payloads through sendPayload so the no-identity branch is exercised.
    const noIdentityAdapter: ChannelOutboundAdapter = {
      deliveryMode: "direct",
      sendTextOnlyErrorPayloads: true,
      deliveryCapabilities: {
        durableFinal: { text: true, payload: true, messageSendingHooks: true },
      },
      sendText: async () => ({ channel: matrixPluginId, messageId: "unused-text" }),
      sendPayload: async () => ({ channel: matrixPluginId, messageId: "" }),
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: matrixPluginId,
          source: "test",
          plugin: createOutboundTestPlugin({ id: matrixPluginId, outbound: noIdentityAdapter }),
        },
      ]),
    );
  });

  it("treats a real producer adapter-no-identity outcome as potentially visible", async () => {
    const result = await deliverInboundReplyWithMessageSendContext({
      cfg: {},
      channel: matrixPluginId,
      to: "!room:example",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "final error reply", isError: true },
      ctxPayload: ctxPayload(),
    });

    // Real producer: sendDurableMessageBatch -> deliverCore -> sendPayload
    // returned no identity -> suppressed/adapter_returned_no_identity.
    // Settlement: durable-delivery maps it to handled_visible, not handled_no_send.
    expect(result.status).toBe("handled_visible");
    expect(result.delivery.visibleReplySent).toBe(true);
  });
});
