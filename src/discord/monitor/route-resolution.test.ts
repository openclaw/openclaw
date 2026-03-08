import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";

describe("discord route resolution helpers", () => {
  it("builds a direct peer from DM metadata", () => {
    expect(
      buildDiscordRoutePeer({
        isDirectMessage: true,
        isGroupDm: false,
        directUserId: "user-1",
        conversationId: "channel-1",
      }),
    ).toEqual({
      kind: "direct",
      id: "user-1",
    });
  });

  it("resolves bound session keys on top of the routed session", () => {
    const route: ResolvedAgentRoute = {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:channel:c1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    };

    expect(
      resolveDiscordEffectiveRoute({
        route,
        boundSessionKey: "agent:worker:discord:channel:c1",
        matchedBy: "binding.channel",
      }),
    ).toEqual({
      ...route,
      agentId: "worker",
      sessionKey: "agent:worker:discord:channel:c1",
      matchedBy: "binding.channel",
    });
  });

  it("falls back to configured route when no bound session exists", () => {
    const route: ResolvedAgentRoute = {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:channel:c1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    };
    const configuredRoute = {
      route: {
        ...route,
        agentId: "worker",
        sessionKey: "agent:worker:discord:channel:c1",
        mainSessionKey: "agent:worker:main",
        matchedBy: "binding.peer" as const,
      },
    };

    expect(
      resolveDiscordEffectiveRoute({
        route,
        configuredRoute,
      }),
    ).toEqual(configuredRoute.route);
  });

  it("resolves the same route shape as the inline Discord route inputs", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "worker" }],
      },
      bindings: [
        {
          agentId: "worker",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "c1" },
          },
        },
      ],
    };

    expect(
      resolveDiscordConversationRoute({
        cfg,
        accountId: "default",
        guildId: "g1",
        memberRoleIds: [],
        peer: { kind: "channel", id: "c1" },
      }),
    ).toMatchObject({
      agentId: "worker",
      sessionKey: "agent:worker:discord:channel:c1",
      matchedBy: "binding.peer",
    });
  });
});
