import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationRouteEligibilitiesForAgent } from "./conversation-route-ownership.js";

type Conversation = Parameters<
  typeof resolveConversationRouteEligibilitiesForAgent
>[0]["conversations"][number];

function resolveRoute(config: OpenClawConfig, agentId: string, conversation: Conversation) {
  return resolveConversationRouteEligibilitiesForAgent({
    config,
    agentId,
    conversations: [conversation],
  });
}

const baseConversation = {
  conversationRef: "conv_11111111111111111111111111111111",
  accountId: "default",
  channel: "reef",
  kind: "group" as const,
  peerId: "topic-42",
  target: "group:topic-42",
};

function configWithPeer(id: string, teamId?: string): OpenClawConfig {
  return {
    agents: { entries: { main: {}, finance: {} } },
    bindings: [
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id }, ...(teamId ? { teamId } : {}) },
      },
      { type: "route", agentId: "main", match: { channel: "reef" } },
    ],
  };
}

describe("resolveConversationRouteEligibilitiesForAgent", () => {
  it("replays authoritative parent context when selecting the route owner", async () => {
    const config = configWithPeer("parent-room");
    const conversation = {
      ...baseConversation,
      routeContextObserved: true as const,
      routeContext: { parentPeerId: "parent-room" },
    };

    await expect(resolveRoute(config, "main", conversation)).resolves.toEqual(["denied"]);
    await expect(resolveRoute(config, "finance", conversation)).resolves.toEqual(["eligible"]);
  });

  it("does not treat an unrelated peer binding as a possible parent owner for a legacy thread", async () => {
    const config = configWithPeer("unrelated-room");

    await expect(
      resolveRoute(config, "main", { ...baseConversation, threadId: "topic-7" }),
    ).resolves.toEqual(["eligible"]);
  });

  it("replays a legacy thread parent binding from its retained route peer", async () => {
    const config = configWithPeer("parent-room");
    const conversation = { ...baseConversation, peerId: "parent-room", threadId: "topic-7" };

    await expect(resolveRoute(config, "main", conversation)).resolves.toEqual(["denied"]);
    await expect(resolveRoute(config, "finance", conversation)).resolves.toEqual(["eligible"]);
  });

  it("fails closed for a matching contextual wildcard when legacy context is absent", async () => {
    const config = configWithPeer("*", "finance");

    await expect(resolveRoute(config, "main", baseConversation)).resolves.toEqual(["denied"]);

    await expect(
      resolveRoute(config, "main", { ...baseConversation, routeContextObserved: true }),
    ).resolves.toEqual(["eligible"]);
  });
});
