import { describe, expect, test } from "vitest";
import { AgentSelectionRequiredError, resolveAgentConfig } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentRouteBinding } from "../config/types.agents.js";
import {
  listExactDirectMessageBindingPeerIds,
  resolveAgentRoute,
  resolveInboundLastRouteSessionKey,
} from "./resolve-route.js";

type CompatRoutePeerKind =
  | NonNullable<Parameters<typeof resolveAgentRoute>[0]["peer"]>["kind"]
  | "dm";

function routeFor(cfg: OpenClawConfig, channel = "discord") {
  return (
    peer: Parameters<typeof resolveAgentRoute>[0]["peer"],
    overrides: Partial<Omit<Parameters<typeof resolveAgentRoute>[0], "cfg" | "peer">> = {},
  ) => resolveAgentRoute({ cfg, channel, accountId: "default", peer, ...overrides });
}

function binding(agentId: string, match: AgentRouteBinding["match"]): AgentRouteBinding {
  return { agentId, match };
}

function boundRoute(channel: string, bindings: AgentRouteBinding[], cfg: OpenClawConfig = {}) {
  return routeFor({ ...cfg, bindings }, channel);
}

type Route = ReturnType<typeof resolveAgentRoute>;
function expectMainAgentRoute(
  route: Route,
  sessionKey: string,
  matchedBy: Route["matchedBy"],
  lastRoutePolicy: Route["lastRoutePolicy"],
) {
  expect(route).toMatchObject({ agentId: "main", sessionKey, matchedBy, lastRoutePolicy });
}

function createCompatPeer(kind: CompatRoutePeerKind, id: string) {
  return { kind, id } as unknown as NonNullable<Parameters<typeof resolveAgentRoute>[0]["peer"]>;
}

function mainBindingConfig(
  entries: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return {
    agents: { entries },
    bindings: [{ ...binding("main", { channel: "discord", accountId: "default" }), type: "route" }],
  };
}

describe("resolveAgentRoute", () => {
  const directRoute = (cfg: OpenClawConfig, channel: string, id: string) =>
    resolveAgentRoute({ cfg, channel, accountId: null, peer: { kind: "direct", id } });

  test("preserves explicit main bindings when agents.entries has other agents", () => {
    expectMainAgentRoute(
      routeFor(mainBindingConfig({ alpha: {} }))({ kind: "direct", id: "user-1" }),
      "agent:main:main",
      "binding.account",
      "main",
    );
  });

  test("resolves exact main bindings through a configured normalized main-like roster entry", () => {
    const cfg = mainBindingConfig({ MAIN: { model: "anthropic/claude-3-5-sonnet" } });
    const route = routeFor(cfg)({ kind: "direct", id: "user-1" });
    expectMainAgentRoute(route, "agent:main:main", "binding.account", "main");
    expect(resolveAgentConfig(cfg, route.agentId)?.model).toBe("anthropic/claude-3-5-sonnet");
  });

  test("dmScope=per-peer controls direct-message session key isolation", () => {
    const route = directRoute({ session: { dmScope: "per-peer" } }, "whatsapp", "+15551234567");
    expectMainAgentRoute(route, "agent:main:direct:+15551234567", "default", "session");
  });

  test("binding groupScope routes a selected room into main without changing direct messages", () => {
    const route = boundRoute(
      "slack",
      [
        {
          ...binding("main", { channel: "slack", peer: { kind: "channel", id: "isolated-room" } }),
          session: { groupScope: "main" },
        },
      ],
      { session: { dmScope: "per-channel-peer", groupScope: "per-group" } },
    );
    expect(route({ kind: "channel", id: "isolated-room" }).sessionKey).toBe("agent:main:main");
    expect(route({ kind: "group", id: "shared-room" }).sessionKey).toBe(
      "agent:main:slack:group:shared-room",
    );
    expect(route({ kind: "direct", id: "teammate" }).sessionKey).toBe(
      "agent:main:slack:direct:teammate",
    );
  });

  test("keeps explicit groupScope overrides distinct in the route cache", () => {
    const route = routeFor({}, "slack");
    const peer = { kind: "channel" as const, id: "team-room" };
    expect(route(peer, { groupScope: "per-group" }).sessionKey).toBe(
      "agent:main:slack:channel:team-room",
    );
    expect(route(peer, { groupScope: "main" }).sessionKey).toBe("agent:main:main");
  });

  test("route binding session dmScope isolates selected direct peers without changing agent", () => {
    const route = routeFor({
      session: { dmScope: "main" },
      bindings: ["1497598990336790559", "389224669418618880"].map((id) => ({
        type: "route",
        agentId: "main",
        match: { channel: "discord", accountId: "default", peer: { kind: "direct", id } },
        session: { dmScope: "per-account-channel-peer" },
      })),
    });

    expectMainAgentRoute(
      route({ kind: "direct", id: "358611388488351744" }),
      "agent:main:main",
      "default",
      "main",
    );
    expectMainAgentRoute(
      route({ kind: "direct", id: "1497598990336790559" }),
      "agent:main:discord:default:direct:1497598990336790559",
      "binding.peer",
      "session",
    );
    expectMainAgentRoute(
      route({ kind: "direct", id: "389224669418618880" }),
      "agent:main:discord:default:direct:389224669418618880",
      "binding.peer",
      "session",
    );
    expectMainAgentRoute(
      route({ kind: "channel", id: "1494710434396110868" }),
      "agent:main:discord:channel:1494710434396110868",
      "default",
      "session",
    );
    expectMainAgentRoute(
      route(null, { channel: "webchat", accountId: null }),
      "agent:main:main",
      "default",
      "main",
    );
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
    const route = routeFor({})({ kind: "channel", id: 1468834856187203680n as unknown as string });
    expect(route.sessionKey).toBe("agent:main:discord:channel:1468834856187203680");
  });

  describe.each([
    { channel: "discord", scope: "guildId", matchedBy: "binding.guild" },
    { channel: "slack", scope: "teamId", matchedBy: "binding.team" },
  ] as const)("peer+$scope constraints", ({ channel, scope, matchedBy }) => {
    test("does not become a scope-wide fallback when the peer mismatches (#14752)", () => {
      const route = boundRoute(channel, [
        binding("peer", { channel, [scope]: "space", peer: { kind: "channel", id: "room-a" } }),
        binding("fallback", { channel, [scope]: "space" }),
      ]);
      expect(route({ kind: "channel", id: "room-b" }, { [scope]: "space" })).toMatchObject({
        agentId: "fallback",
        matchedBy,
      });
    });

    test("requires a matching scope even when the peer matches", () => {
      const route = boundRoute(channel, [
        binding("wrong", { channel, [scope]: "other", peer: { kind: "channel", id: "room" } }),
        binding("right", { channel, [scope]: "space" }),
      ]);
      expect(route({ kind: "channel", id: "room" }, { [scope]: "space" })).toMatchObject({
        agentId: "right",
        matchedBy,
      });
    });
  });
});

describe("parentPeer binding inheritance (thread support)", () => {
  const threadPeer = { kind: "channel" as const, id: "thread-456" };
  const defaultParentPeer = { kind: "channel" as const, id: "parent-channel-123" };
  function makeDiscordPeerBinding(agentId: string, peerId: string) {
    return binding(agentId, { channel: "discord", peer: { kind: "channel", id: peerId } });
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
    const route = boundRoute("whatsapp", [
      binding("alex", { channel: "whatsapp", peer: createCompatPeer("direct", "+15551234567") }),
    ])(createCompatPeer("dm", "+15551234567"), { accountId: null });
    expect(route).toMatchObject({ agentId: "alex", matchedBy: "binding.peer" });
  });

  test.each([
    ["slack-group-agent", "group", "channel"],
    ["slack-channel-agent", "channel", "group"],
  ] as const)(
    "%s: config %s binding matches runtime %s scope",
    (agentId, bindingPeerKind, runtimePeerKind) => {
      const route = boundRoute("slack", [
        binding(agentId, { channel: "slack", peer: createCompatPeer(bindingPeerKind, "C123456") }),
      ])(createCompatPeer(runtimePeerKind, "C123456"), { accountId: null });
      expect(route).toMatchObject({ agentId, matchedBy: "binding.peer" });
    },
  );
});

test("peer+guild+roles binding does not act as guild+roles fallback when peer mismatches", () => {
  const match = { channel: "discord", guildId: "g1", roles: ["r1"] };
  const route = routeFor({
    bindings: [
      binding("peer-roles", { ...match, peer: { kind: "channel", id: "c-target" } }),
      binding("guild-roles", match),
    ],
  })({ kind: "channel", id: "c-other" }, { guildId: "g1", memberRoleIds: ["r1"] });
  expect(route).toMatchObject({ agentId: "guild-roles", matchedBy: "binding.guild+roles" });
});

describe("unknown direct-message route decisions", () => {
  test("lists unique exact peers from normalized account and any-account bindings", () => {
    const peerBinding = (id: string, accountId: string, kind: "direct" | "group" = "direct") =>
      binding("main", { channel: "Telegram", accountId, peer: { kind, id } });
    const cfg = {
      bindings: [
        peerBinding("peer-b", "*"),
        peerBinding("peer-a", " WORK "),
        peerBinding("peer-b", "work"),
        peerBinding("*", "work"),
        peerBinding("room", "work", "group"),
        peerBinding("other", "other"),
      ],
    } satisfies OpenClawConfig;

    expect(
      listExactDirectMessageBindingPeerIds({ cfg, channel: " telegram ", accountId: " work " }),
    ).toEqual(["peer-b", "peer-a"]);
  });

  test("account outranks channel for an unknown direct peer", () => {
    const route = boundRoute("telegram", [
      binding("exact", { channel: "telegram", peer: { kind: "direct", id: "known-user" } }),
      binding("account", { channel: "telegram" }),
      binding("channel", { channel: "telegram", accountId: "*" }),
    ]);
    expect(route({ kind: "direct", id: "" })).toMatchObject({
      agentId: "account",
      matchedBy: "binding.account",
    });
  });
});

test("peer.id=* does not match group peers when kind is direct", () => {
  const route = boundRoute(
    "telegram",
    [
      binding("dm-only", {
        channel: "telegram",
        accountId: "bot1",
        peer: { kind: "direct", id: "*" },
      }),
    ],
    { agents: { entries: { main: {}, "dm-only": {} } } },
  )({ kind: "group", id: "group-999" }, { accountId: "bot1", defaultAgentId: "main" });
  expect(route).toMatchObject({ agentId: "main", matchedBy: "default" });
});
