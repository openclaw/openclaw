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
import {
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";

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
    // Explicit status guard narrows the result union so `.delivery` typechecks
    // (vitest's expect().toBe() does not narrow; matches the adjacent unit test).
    if (result.status !== "handled_visible") {
      throw new Error(`expected handled_visible, got ${result.status}`);
    }
    expect(result.delivery.visibleReplySent).toBe(true);

    // Lifecycle settlement boundary (lifecycle.ts:519-522): the durable result
    // must (1) not throw as a failed delivery, (2) be classified handled so the
    // caller skips fallback, and (3) carry visibleReplySent=true so the private
    // isExplicitlyNonVisibleChannelDelivery predicate (lifecycle.ts:129,
    // `visibleReplySent === false`) settles it as a visible send — emitting
    // message_sent and suppressing a duplicate fallback reply. Current main
    // returns handled_no_send (visibleReplySent=false) for this outcome, which
    // settles as explicitly non-visible and would allow a duplicate reply.
    expect(() => throwIfDurableInboundReplyDeliveryFailed(result)).not.toThrow();
    expect(isDurableInboundReplyDeliveryHandled(result)).toBe(true);
    expect(result.delivery.visibleReplySent).toBe(true);
  });
});
