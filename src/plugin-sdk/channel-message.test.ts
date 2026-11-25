import { describe, expect, it, vi } from "vitest";
import * as channelInbound from "./channel-inbound.js";
import {
  defineChannelMessageAdapter,
  type ChannelMessageDurableFinalAdapter,
} from "./channel-outbound.js";

function dispatch(result: Parameters<typeof channelInbound.resolveInboundReplyDispatchCounts>[0]) {
  return {
    counts: channelInbound.resolveInboundReplyDispatchCounts(result),
    visible: channelInbound.hasVisibleInboundReplyDispatch(result),
    final: channelInbound.hasFinalInboundReplyDispatch(result),
  };
}

describe("defineChannelMessageAdapter", () => {
  it("preserves legacy count-shaped dispatch projections", () => {
    const legacyResult = {
      queuedFinal: false,
      counts: { tool: 1, block: 2, final: 1 },
    };
    expect(dispatch(legacyResult)).toEqual({
      counts: { tool: 1, block: 2, final: 1 },
      visible: true,
      final: true,
    });
    const receiptResult = {
      ...legacyResult,
      queuedFinal: true,
      settledReceipt: { anyVisibleDelivered: false, counts: {} },
    };
    expect(dispatch(receiptResult)).toEqual({
      counts: { tool: 0, block: 0, final: 0 },
      visible: false,
      final: false,
    });
  });

  it("defaults new message adapters to plugin-owned receive acknowledgement", () => {
    const adapter = defineChannelMessageAdapter({
      id: "demo",
      durableFinal: { capabilities: { text: true } },
    });

    expect(adapter.receive).toEqual({
      defaultAckPolicy: "manual",
      supportedAckPolicies: ["manual"],
    });
  });

  it("preserves explicit receive acknowledgement policy declarations", () => {
    const adapter = defineChannelMessageAdapter({
      id: "demo",
      receive: {
        defaultAckPolicy: "after_agent_dispatch",
        supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
      },
    });
    expect(adapter.receive).toEqual({
      defaultAckPolicy: "after_agent_dispatch",
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
    });
  });

  it("exposes the synchronous deferred-delivery admission contract", () => {
    const admitDeferredDelivery = vi.fn<
      NonNullable<ChannelMessageDurableFinalAdapter["admitDeferredDelivery"]>
    >((ctx) =>
      ctx.phase === "recovery"
        ? { status: "permanent_rejection", reason: "account no longer supports replay" }
        : { status: "allowed" },
    );
    const adapter = defineChannelMessageAdapter({
      id: "demo",
      durableFinal: { admitDeferredDelivery },
    });
    const context = {
      cfg: {},
      channel: "demo",
      to: "conversation-1",
      accountId: "workspace-1",
    } as Parameters<typeof admitDeferredDelivery>[0];

    expect(adapter.durableFinal?.admitDeferredDelivery?.({ ...context, phase: "live" })).toEqual({
      status: "allowed",
    });
    expect(
      adapter.durableFinal?.admitDeferredDelivery?.({ ...context, phase: "recovery" }),
    ).toEqual({
      status: "permanent_rejection",
      reason: "account no longer supports replay",
    });
  });
});
