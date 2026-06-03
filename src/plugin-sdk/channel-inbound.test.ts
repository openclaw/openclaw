/**
 * Tests channel inbound context and dispatch helper behavior.
 */
import { describe, expect, it } from "vitest";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
  type InboundReplyDispatchResult,
  type TurnState,
} from "./channel-inbound.js";

function createInboundParams(
  overrides: Partial<BuildChannelInboundEventContextParams> = {},
): BuildChannelInboundEventContextParams {
  return {
    channel: "test",
    messageId: "msg-1",
    from: "test:user:u1",
    sender: { id: "u1" },
    conversation: {
      kind: "group",
      id: "room-1",
    },
    route: {
      agentId: "main",
      routeSessionKey: "agent:main:test:group:room-1",
    },
    reply: {
      to: "test:room:room-1",
    },
    message: {
      rawBody: "side chatter",
      inboundEventKind: "room_event",
    },
    ...overrides,
  };
}

describe("channel-inbound public helpers", () => {
  it("builds inbound event kind into message context", async () => {
    const ctx = buildChannelInboundEventContext(createInboundParams());

    expect(ctx.InboundEventKind).toBe("room_event");
  });

  it("exposes typed turn state on inbound reply results", () => {
    const state: TurnState = {
      currentState: "failed",
      visibleDeliveryRequired: true,
      visibleDeliverySent: false,
      completionAllowed: false,
      errors: ["missing_visible_delivery"],
    };
    const result = {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: { Body: "hello" },
      routeSessionKey: "agent:main:test:peer",
      dispatchResult: { queuedFinal: false },
      turnState: state,
    } as InboundReplyDispatchResult<{ queuedFinal: boolean }>;

    expect(result.dispatched).toBe(true);
    if (result.dispatched) {
      expect(result.turnState?.completionAllowed).toBe(false);
      expect(result.turnState?.errors).toContain("missing_visible_delivery");
    }
  });
});
