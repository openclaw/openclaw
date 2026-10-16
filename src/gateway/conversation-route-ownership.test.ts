import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationRouteEligibilitiesForAgent } from "./conversation-route-ownership.js";

function resolveRoute(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: Parameters<
    typeof resolveConversationRouteEligibilitiesForAgent
  >[0]["conversations"][number];
}) {
  return resolveConversationRouteEligibilitiesForAgent({
    ...params,
    conversations: [params.conversation],
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

function configWithBindings(bindings: NonNullable<OpenClawConfig["bindings"]>): OpenClawConfig {
  return {
    agents: { entries: { main: {}, finance: {} } },
    bindings: [...bindings, { type: "route", agentId: "main", match: { channel: "reef" } }],
  };
}

describe("resolveConversationRouteEligibilitiesForAgent", () => {
  it("replays authoritative parent context when selecting the route owner", async () => {
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

    await expect(resolveRoute({ config, agentId: "main", conversation })).resolves.toEqual([
      "denied",
    ]);
    await expect(resolveRoute({ config, agentId: "finance", conversation })).resolves.toEqual([
      "eligible",
    ]);
  });

  it("does not treat an unrelated peer binding as a possible parent owner for a legacy thread", async () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "unrelated-room" } },
      },
    ]);

    await expect(
      resolveRoute({
        config,
        agentId: "main",
        conversation: { ...baseConversation, threadId: "topic-7" },
      }),
    ).resolves.toEqual(["eligible"]);
  });

  it("replays a legacy thread parent binding from its retained route peer", async () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "parent-room" } },
      },
    ]);
    const conversation = { ...baseConversation, peerId: "parent-room", threadId: "topic-7" };

    await expect(resolveRoute({ config, agentId: "main", conversation })).resolves.toEqual([
      "denied",
    ]);
    await expect(resolveRoute({ config, agentId: "finance", conversation })).resolves.toEqual([
      "eligible",
    ]);
  });

  it("fails closed for a matching contextual wildcard when legacy context is absent", async () => {
    const config = configWithBindings([
      {
        type: "route",
        agentId: "finance",
        match: { channel: "reef", peer: { kind: "group", id: "*" }, teamId: "finance" },
      },
    ]);

    await expect(
      resolveRoute({
        config,
        agentId: "main",
        conversation: baseConversation,
      }),
    ).resolves.toEqual(["denied"]);

    await expect(
      resolveRoute({
        config,
        agentId: "main",
        conversation: { ...baseConversation, routeContextObserved: true },
      }),
    ).resolves.toEqual(["eligible"]);
  });
});
