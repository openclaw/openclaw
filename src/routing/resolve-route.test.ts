import { describe, expect, test } from "vitest";
import { AgentSelectionRequiredError, resolveAgentConfig } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  listExactDirectMessageBindingPeerIds,
  resolveAgentRoute,
  resolveInboundLastRouteSessionKey,
} from "./resolve-route.js";

type CompatRoutePeerKind =
  | NonNullable<Parameters<typeof resolveAgentRoute>[0]["peer"]>["kind"]
  | "dm";

const resolveRoute = (
  params: Omit<Parameters<typeof resolveAgentRoute>[0], "cfg"> & { cfg?: OpenClawConfig },
) => resolveAgentRoute({ cfg: params.cfg ?? {}, ...params });

function expectResolvedRoute(
  route: ReturnType<typeof resolveAgentRoute>,
  expected: Partial<ReturnType<typeof resolveAgentRoute>>,
) {
  expect(route).toMatchObject(expected);
}

function createCompatPeer(kind: CompatRoutePeerKind, id: string) {
  return { kind, id } as unknown as NonNullable<Parameters<typeof resolveAgentRoute>[0]["peer"]>;
}

function mainBindingConfig(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return {
    agents: { entries },
    bindings: [
      { type: "route", agentId: "main", match: { channel: "discord", accountId: "default" } },
    ],
  };
}

describe("resolveAgentRoute", () => {
  const directRoute = (cfg: OpenClawConfig, channel: string, id: string) =>
    resolveAgentRoute({ cfg, channel, accountId: null, peer: { kind: "direct", id } });

  test("preserves explicit main bindings when agents.entries has other agents", () => {
    const route = resolveAgentRoute({
      cfg: mainBindingConfig({ alpha: {} }),
      channel: "discord",
      accountId: "default",
      peer: { kind: "direct", id: "user-1" },
    });

    expectResolvedRoute(route, {
      agentId: "main",
      sessionKey: "agent:main:main",
      matchedBy: "binding.account",
      lastRoutePolicy: "main",
    });
  });

  test("resolves exact main bindings through a configured normalized main-like roster entry", () => {
    const cfg = mainBindingConfig({ MAIN: { model: "anthropic/claude-3-5-sonnet" } });
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "direct", id: "user-1" },
    });

    expectResolvedRoute(route, {
      agentId: "main",
      sessionKey: "agent:main:main",
      matchedBy: "binding.account",
      lastRoutePolicy: "main",
    });
    expect(resolveAgentConfig(cfg, route.agentId)?.model).toBe("anthropic/claude-3-5-sonnet");
  });

  test("dmScope=per-peer controls direct-message session key isolation", () => {
    const route = directRoute({ session: { dmScope: "per-peer" } }, "whatsapp", "+15551234567");
    expectResolvedRoute(route, {
      agentId: "main",
      matchedBy: "default",
      lastRoutePolicy: "session",
      sessionKey: "agent:main:direct:+15551234567",
    });
  });

  test("binding groupScope routes a selected room into main without changing direct messages", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "per-channel-peer", groupScope: "per-group" },
      bindings: [
        {
          agentId: "main",
          match: { channel: "slack", peer: { kind: "channel", id: "isolated-room" } },
          session: { groupScope: "main" },
        },
      ],
    };

    expect(
      resolveRoute({ cfg, channel: "slack", peer: { kind: "channel", id: "isolated-room" } })
        .sessionKey,
    ).toBe("agent:main:main");
    expect(
      resolveRoute({ cfg, channel: "slack", peer: { kind: "group", id: "shared-room" } })
        .sessionKey,
    ).toBe("agent:main:slack:group:shared-room");
    expect(
      resolveRoute({ cfg, channel: "slack", peer: { kind: "direct", id: "teammate" } }).sessionKey,
    ).toBe("agent:main:slack:direct:teammate");
  });

  test("keeps explicit groupScope overrides distinct in the route cache", () => {
    const cfg: OpenClawConfig = {};
    const input = {
      cfg,
      channel: "slack",
      peer: { kind: "channel" as const, id: "team-room" },
    };

    expect(resolveAgentRoute({ ...input, groupScope: "per-group" }).sessionKey).toBe(
      "agent:main:slack:channel:team-room",
    );
    expect(resolveAgentRoute({ ...input, groupScope: "main" }).sessionKey).toBe("agent:main:main");
  });

  test("route binding session dmScope isolates selected direct peers without changing agent", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "main" },
      bindings: ["1497598990336790559", "389224669418618880"].map((id) => ({
        type: "route",
        agentId: "main",
        match: { channel: "discord", accountId: "default", peer: { kind: "direct", id } },
        session: { dmScope: "per-account-channel-peer" },
      })),
    };
    const route = (
      peer: Parameters<typeof resolveAgentRoute>[0]["peer"],
      channel = "discord",
      accountId: string | null = "default",
    ) => resolveAgentRoute({ cfg, channel, accountId, peer });

    expectResolvedRoute(route({ kind: "direct", id: "358611388488351744" }), {
      agentId: "main",
      sessionKey: "agent:main:main",
      matchedBy: "default",
      lastRoutePolicy: "main",
    });
    expectResolvedRoute(route({ kind: "direct", id: "1497598990336790559" }), {
      agentId: "main",
      sessionKey: "agent:main:discord:default:direct:1497598990336790559",
      matchedBy: "binding.peer",
      lastRoutePolicy: "session",
    });
    expectResolvedRoute(route({ kind: "direct", id: "389224669418618880" }), {
      agentId: "main",
      sessionKey: "agent:main:discord:default:direct:389224669418618880",
      matchedBy: "binding.peer",
      lastRoutePolicy: "session",
    });
    expectResolvedRoute(route({ kind: "channel", id: "1494710434396110868" }), {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:1494710434396110868",
      matchedBy: "default",
      lastRoutePolicy: "session",
    });
    expectResolvedRoute(route(null, "webchat", null), {
      agentId: "main",
      sessionKey: "agent:main:main",
      matchedBy: "default",
      lastRoutePolicy: "main",
    });
  });

  test.each([
    ["main", "agent:main:discord:direct:user-1", "agent:main:main"],
    ["session", "agent:main:telegram:atlas:direct:123", "agent:main:telegram:atlas:direct:123"],
  ] as const)(
    "inbound last-route policy %s maps %s to %s",
    (lastRoutePolicy, sessionKey, expected) => {
      const route = { mainSessionKey: "agent:main:main", lastRoutePolicy };
      expect(resolveInboundLastRouteSessionKey({ route, sessionKey })).toBe(expected);
    },
  );

  test("forwards identity links to direct-message session isolation", () => {
    const route = directRoute(
      {
        session: {
          dmScope: "per-channel-peer",
          identityLinks: { alice: ["telegram:111111111", "discord:222222222222222222"] },
        },
      },
      "discord",
      "222222222222222222",
    );
    expect(route.sessionKey).toBe("agent:main:discord:direct:alice");
  });

  test("coerces numeric peer ids to stable session keys", () => {
    const cfg: OpenClawConfig = {};
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "channel", id: 1468834856187203680n as unknown as string },
    });
    expect(route.sessionKey).toBe("agent:main:discord:channel:1468834856187203680");
  });

  describe.each([
    { channel: "discord", scope: "guildId", matchedBy: "binding.guild" },
    { channel: "slack", scope: "teamId", matchedBy: "binding.team" },
  ] as const)("peer+$scope constraints", ({ channel, scope, matchedBy }) => {
    test("does not become a scope-wide fallback when the peer mismatches (#14752)", () => {
      const cfg: OpenClawConfig = {
        bindings: [
          {
            agentId: "peer",
            match: { channel, [scope]: "space", peer: { kind: "channel", id: "room-a" } },
          },
          { agentId: "fallback", match: { channel, [scope]: "space" } },
        ],
      };
      expectResolvedRoute(
        resolveRoute({ cfg, channel, [scope]: "space", peer: { kind: "channel", id: "room-b" } }),
        { agentId: "fallback", matchedBy },
      );
    });

    test("requires a matching scope even when the peer matches", () => {
      const cfg: OpenClawConfig = {
        bindings: [
          {
            agentId: "wrong",
            match: { channel, [scope]: "other", peer: { kind: "channel", id: "room" } },
          },
          { agentId: "right", match: { channel, [scope]: "space" } },
        ],
      };
      expectResolvedRoute(
        resolveRoute({ cfg, channel, [scope]: "space", peer: { kind: "channel", id: "room" } }),
        { agentId: "right", matchedBy },
      );
    });
  });
});

describe("parentPeer binding inheritance (thread support)", () => {
  const threadPeer = { kind: "channel" as const, id: "thread-456" };
  const defaultParentPeer = { kind: "channel" as const, id: "parent-channel-123" };
  function makeDiscordPeerBinding(agentId: string, peerId: string) {
    return {
      agentId,
      match: { channel: "discord", peer: { kind: "channel" as const, id: peerId } },
    };
  }

  test.each([threadPeer.id, defaultParentPeer.id])(
    "rejects an unknown agent in the first matching binding for %s instead of falling back",
    (peerId) => {
      expect(() =>
        resolveAgentRoute({
          channel: "discord",
          peer: threadPeer,
          parentPeer: defaultParentPeer,
          cfg: {
            agents: { entries: { fallback: {} } },
            bindings: [
              makeDiscordPeerBinding("missing", peerId),
              makeDiscordPeerBinding("fallback", peerId),
              { agentId: "fallback", match: { channel: "discord" } },
            ],
          },
        }),
      ).toThrow(AgentSelectionRequiredError);
    },
  );
});

describe("backward compatibility: peer.kind aliases", () => {
  test("runtime dm peer.kind matches config direct binding (#22730)", () => {
    const route = resolveAgentRoute({
      cfg: {
        bindings: [
          {
            agentId: "alex",
            match: {
              channel: "whatsapp",
              peer: createCompatPeer("direct", "+15551234567"),
            },
          },
        ],
      },
      channel: "whatsapp",
      accountId: null,
      peer: createCompatPeer("dm", "+15551234567"),
    });
    expectResolvedRoute(route, {
      agentId: "alex",
      matchedBy: "binding.peer",
    });
  });

  test.each([
    ["slack-group-agent", "group", "channel"],
    ["slack-channel-agent", "channel", "group"],
  ] as const)(
    "%s: config %s binding matches runtime %s scope",
    (agentId, bindingPeerKind, runtimePeerKind) => {
      const route = resolveAgentRoute({
        cfg: {
          bindings: [
            {
              agentId,
              match: {
                channel: "slack",
                peer: createCompatPeer(bindingPeerKind, "C123456"),
              },
            },
          ],
        },
        channel: "slack",
        accountId: null,
        peer: createCompatPeer(runtimePeerKind, "C123456"),
      });
      expectResolvedRoute(route, {
        agentId,
        matchedBy: "binding.peer",
      });
    },
  );
});

describe("role-based agent routing", () => {
  test("peer+guild+roles binding does not act as guild+roles fallback when peer mismatches", () => {
    const match = { channel: "discord", guildId: "g1", roles: ["r1"] };
    const route = resolveAgentRoute({
      cfg: {
        bindings: [
          { agentId: "peer-roles", match: { ...match, peer: { kind: "channel", id: "c-target" } } },
          { agentId: "guild-roles", match },
        ],
      },
      channel: "discord",
      guildId: "g1",
      memberRoleIds: ["r1"],
      peer: { kind: "channel", id: "c-other" },
    });
    expectResolvedRoute(route, { agentId: "guild-roles", matchedBy: "binding.guild+roles" });
  });
});

describe("unknown direct-message route decisions", () => {
  test("lists unique exact peers from normalized account and any-account bindings", () => {
    const binding = (peerId: string, accountId: string, kind: "direct" | "group" = "direct") => ({
      agentId: "main",
      match: { channel: "Telegram", accountId, peer: { kind, id: peerId } },
    });
    const cfg = {
      bindings: [
        binding("peer-b", "*"),
        binding("peer-a", " WORK "),
        binding("peer-b", "work"),
        binding("*", "work"),
        binding("room", "work", "group"),
        binding("other", "other"),
      ],
    } satisfies OpenClawConfig;

    expect(
      listExactDirectMessageBindingPeerIds({ cfg, channel: " telegram ", accountId: " work " }),
    ).toEqual(["peer-b", "peer-a"]);
  });

  test("account outranks channel for an unknown direct peer", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "exact",
          match: { channel: "telegram", peer: { kind: "direct", id: "known-user" } },
        },
        { agentId: "account", match: { channel: "telegram" } },
        { agentId: "channel", match: { channel: "telegram", accountId: "*" } },
      ],
    };
    expectResolvedRoute(
      resolveAgentRoute({
        cfg,
        channel: "telegram",
        accountId: "default",
        peer: { kind: "direct", id: "" },
      }),
      { agentId: "account", matchedBy: "binding.account" },
    );
  });
});

describe("wildcard peer bindings (peer.id=*)", () => {
  test("peer.id=* does not match group peers when kind is direct", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, "dm-only": {} } },
      bindings: [
        {
          agentId: "dm-only",
          match: {
            channel: "telegram",
            accountId: "bot1",
            peer: { kind: "direct", id: "*" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: "bot1",
      peer: { kind: "group", id: "group-999" },
      defaultAgentId: "main",
    });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("default");
  });
});
