import { describe, expect, test, vi } from "vitest";
import * as configBindings from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveAgentRoute,
  type ResolveAgentRouteInput,
  type ResolvedAgentRoute,
} from "./resolve-route.js";

type RouteInput = Omit<ResolveAgentRouteInput, "cfg" | "channel">;
type RouteCheck = [RouteInput, string, ResolvedAgentRoute["matchedBy"], string?];
type Binding = [string, Partial<AgentRouteBinding["match"]>];
function routeConfig(
  channel: string,
  bindings: Binding[],
  agentIds = bindings.map(([id]) => id),
): OpenClawConfig {
  return {
    agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
    bindings: bindings.map(([agentId, match]) => ({
      agentId,
      match: { channel, accountId: "default", ...match },
    })),
  };
}
function checkRoutes(cfg: OpenClawConfig, channel: string, checks: RouteCheck[]) {
  for (const [input, agentId, matchedBy, sessionKey] of checks) {
    const route = resolveAgentRoute({ cfg, channel, accountId: "default", ...input });
    expect(route).toMatchObject({ agentId, matchedBy });
    if (sessionKey !== undefined) {
      expect(route.sessionKey).toBe(sessionKey);
    }
  }
}
const collisionCases: Array<[string, Binding[], RouteCheck[]]> = [
  [
    "peer and guild separators",
    [
      ["whole-peer", { peer: { kind: "group", id: "room\t-\tguild-1" } }],
      ["guild-room", { peer: { kind: "group", id: "room" }, guildId: "guild-1" }],
    ],
    [
      [{ peer: { kind: "group", id: "room\t-\tguild-1" } }, "whole-peer", "binding.peer"],
      [{ peer: { kind: "group", id: "room" }, guildId: "guild-1" }, "guild-room", "binding.peer"],
    ],
  ],
  [
    "role separators",
    [
      ["comma-role", { guildId: "guild-1", roles: ["a,b"] }],
      ["suffix-role", { guildId: "guild-1", roles: ["b,c"] }],
    ],
    [
      [{ guildId: "guild-1", memberRoleIds: ["a,b", "c"] }, "comma-role", "binding.guild+roles"],
      [{ guildId: "guild-1", memberRoleIds: ["a", "b,c"] }, "suffix-role", "binding.guild+roles"],
    ],
  ],
  [
    "omitted guild versus literal hyphen",
    [["hyphen-guild", { guildId: "-" }]],
    [
      [{ peer: { kind: "group", id: "room" }, defaultAgentId: "main" }, "main", "default"],
      [{ peer: { kind: "group", id: "room" }, guildId: "-" }, "hyphen-guild", "binding.guild"],
    ],
  ],
];

describe("resolved route cache keys", () => {
  test("keeps cached routes independent of returned route mutations", () => {
    const input: ResolveAgentRouteInput = {
      cfg: { agents: { entries: { main: {} } } },
      channel: "discord",
      peer: { kind: "direct", id: "user-1" },
    };
    let route = resolveAgentRoute(input);
    const expected = { ...route };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      route.agentId = "caller-owned-agent";
      route.sessionKey = "caller-owned-session";
      route = resolveAgentRoute(input);
      expect(route).toEqual(expected);
    }
  });

  test.each(collisionCases)("keeps %s distinct in cached routes", (_name, bindings, checks) => {
    const ids = checks.map(([, id]) => id);
    const cfg = routeConfig("discord", bindings, ids);
    checkRoutes(cfg, "discord", checks);
  });

  test("keeps peer presence, kind, and id distinct across cached route tiers", () => {
    const cfg = routeConfig("telegram", [
      ["known-direct", { peer: { kind: "direct", id: "known" } }],
      ["any-direct", { peer: { kind: "direct", id: "*" } }],
      ["any-group", { peer: { kind: "group", id: "*" } }],
      ["account-wide", { accountId: "work" }],
      ["channel-wide", { accountId: "*" }],
    ]);
    const checks: RouteCheck[] = [
      [{}, "channel-wide", "binding.channel"],
      [{ peer: { kind: "direct", id: "" } }, "any-direct", "binding.peer.wildcard"],
      [
        { peer: { kind: "group", id: "" } },
        "any-group",
        "binding.peer.wildcard",
        "agent:any-group:telegram:group:unknown",
      ],
      [{ peer: { kind: "direct", id: "known" } }, "known-direct", "binding.peer"],
      [{ accountId: "work" }, "account-wide", "binding.account"],
    ];
    checkRoutes(cfg, "telegram", [...checks, ...checks.slice(0, 2)]);
  });
  test("does not rescan full bindings across distinct channel/account cache entries (#36915)", () => {
    const input = (index: number) => ({
      channel: "dingtalk",
      accountId: `acct-${index}`,
      peer: { kind: "direct" as const, id: `user-${index}` },
    });
    const cfg: OpenClawConfig = { bindings: [{ agentId: "agent-0", match: input(0) }] };
    const route = (index: number) => resolveAgentRoute({ cfg, ...input(index) });
    const listBindingsSpy = vi.spyOn(configBindings, "listRouteBindings");
    try {
      expect(route(0)).toMatchObject({ agentId: "agent-0", matchedBy: "binding.peer" });
      for (let index = 1; index < 64; index += 1) {
        expect(route(index)).toMatchObject({ agentId: "main", matchedBy: "default" });
      }
      expect(route(0).agentId).toBe("agent-0");
      expect(listBindingsSpy).toHaveBeenCalledTimes(1);
    } finally {
      listBindingsSpy.mockRestore();
    }
  });
});
