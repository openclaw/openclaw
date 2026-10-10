import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertConversationRouteEligibleForAgent } from "./conversation-route-ownership.js";

const baseConversation = {
  conversationRef: "conv_11111111111111111111111111111111",
  accountId: "default",
  channel: "reef",
  kind: "group" as const,
  peerId: "topic-42",
  target: "group:topic-42",
};

function configWithBindings(bindings: NonNullable<OpenClawConfig["bindings"]>): OpenClawConfig {
  return {
    agents: { entries: { main: {}, finance: {} } },
    bindings: [...bindings, { type: "route", agentId: "main", match: { channel: "reef" } }],
  };
}

describe("assertConversationRouteEligibleForAgent", () => {
  it("replays authoritative parent context when selecting the route owner", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "parent-room" } },
      },
    ]);
    const conversation = {
      ...baseConversation,
      routeContextObserved: true as const,
      routeContext: { parentPeerId: "parent-room" },
    };

    expect(() =>
      assertConversationRouteEligibleForAgent({ config, agentId: "main", conversation }),
    ).toThrow("Conversation is not available to this agent");
    expect(() =>
      assertConversationRouteEligibleForAgent({ config, agentId: "finance", conversation }),
    ).not.toThrow();
  });

  it("does not treat an unrelated peer binding as a possible parent owner for a legacy thread", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "unrelated-room" } },
      },
    ]);

    expect(() =>
      assertConversationRouteEligibleForAgent({
        config,
        agentId: "main",
        conversation: { ...baseConversation, threadId: "topic-7" },
      }),
    ).not.toThrow();
  });

  it("replays a legacy thread parent binding from its retained route peer", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "parent-room" } },
      },
    ]);
    const conversation = { ...baseConversation, peerId: "parent-room", threadId: "topic-7" };

    expect(() =>
      assertConversationRouteEligibleForAgent({ config, agentId: "main", conversation }),
    ).toThrow("Conversation is not available to this agent");
    expect(() =>
      assertConversationRouteEligibleForAgent({ config, agentId: "finance", conversation }),
    ).not.toThrow();
  });

  it("fails closed for a matching contextual wildcard when legacy context is absent", () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "*" }, teamId: "finance" },
      },
    ]);

    expect(() =>
      assertConversationRouteEligibleForAgent({
        config,
        agentId: "main",
        conversation: baseConversation,
      }),
    ).toThrow("Conversation is not available to this agent");

    expect(() =>
      assertConversationRouteEligibleForAgent({
        config,
        agentId: "main",
        conversation: { ...baseConversation, routeContextObserved: true },
      }),
    ).not.toThrow();
  });
});
