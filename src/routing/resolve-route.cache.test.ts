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
type RouteCheck = [
  RouteInput,
  Pick<ResolvedAgentRoute, "agentId" | "matchedBy"> &
    Partial<Pick<ResolvedAgentRoute, "sessionKey">>,
];
const collisionCases: Array<{
  name: string;
  bindings: Array<[string, Omit<AgentRouteBinding["match"], "channel" | "accountId">]>;
  checks: RouteCheck[];
}> = [
  {
    name: "peer and guild separators",
    bindings: [
      ["whole-peer", { peer: { kind: "group", id: "room\t-\tguild-1" } }],
      ["guild-room", { peer: { kind: "group", id: "room" }, guildId: "guild-1" }],
    ],
    checks: [
      [
        { peer: { kind: "group", id: "room\t-\tguild-1" } },
        { agentId: "whole-peer", matchedBy: "binding.peer" },
      ],
      [
        { peer: { kind: "group", id: "room" }, guildId: "guild-1" },
        { agentId: "guild-room", matchedBy: "binding.peer" },
      ],
    ],
  },
  {
    name: "role separators",
    bindings: [
      ["comma-role", { guildId: "guild-1", roles: ["a,b"] }],
      ["suffix-role", { guildId: "guild-1", roles: ["b,c"] }],
    ],
    checks: [
      [
        { guildId: "guild-1", memberRoleIds: ["a,b", "c"] },
        { agentId: "comma-role", matchedBy: "binding.guild+roles" },
      ],
      [
        { guildId: "guild-1", memberRoleIds: ["a", "b,c"] },
        { agentId: "suffix-role", matchedBy: "binding.guild+roles" },
      ],
    ],
  },
  {
    name: "omitted guild versus literal hyphen",
    bindings: [["hyphen-guild", { guildId: "-" }]],
    checks: [
      [
        { peer: { kind: "group", id: "room" }, defaultAgentId: "main" },
        { agentId: "main", matchedBy: "default" },
      ],
      [
        { peer: { kind: "group", id: "room" }, guildId: "-" },
        { agentId: "hyphen-guild", matchedBy: "binding.guild" },
      ],
    ],
  },
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

  test.each(collisionCases)("keeps $name distinct in cached routes", ({ bindings, checks }) => {
    const cfg: OpenClawConfig = {
      agents: { entries: Object.fromEntries(checks.map(([, expected]) => [expected.agentId, {}])) },
      bindings: bindings.map(([agentId, match]) => ({
        agentId,
        match: { channel: "discord", accountId: "default", ...match },
      })),
    };
    for (const [input, expected] of checks) {
      expect(
        resolveAgentRoute({ cfg, channel: "discord", accountId: "default", ...input }),
      ).toMatchObject(expected);
    }
  });

  test("keeps peer presence, kind, and id distinct across cached route tiers", () => {
    const bindings: Array<[string, Partial<AgentRouteBinding["match"]>]> = [
      ["known-direct", { peer: { kind: "direct", id: "known" } }],
      ["any-direct", { peer: { kind: "direct", id: "*" } }],
      ["any-group", { peer: { kind: "group", id: "*" } }],
      ["account-wide", { accountId: "work" }],
      ["channel-wide", { accountId: "*" }],
    ];
    const cfg: OpenClawConfig = {
      agents: { entries: Object.fromEntries(bindings.map(([agentId]) => [agentId, {}])) },
      bindings: bindings.map(([agentId, match]) => ({
        agentId,
        match: { channel: "telegram", accountId: "default", ...match },
      })),
    };
    const checks: RouteCheck[] = [
      [{}, { agentId: "channel-wide", matchedBy: "binding.channel" }],
      [
        { peer: { kind: "direct", id: "" } },
        { agentId: "any-direct", matchedBy: "binding.peer.wildcard" },
      ],
      [
        { peer: { kind: "group", id: "" } },
        {
          agentId: "any-group",
          matchedBy: "binding.peer.wildcard",
          sessionKey: "agent:any-group:telegram:group:unknown",
        },
      ],
      [
        { peer: { kind: "direct", id: "known" } },
        { agentId: "known-direct", matchedBy: "binding.peer" },
      ],
      [{ accountId: "work" }, { agentId: "account-wide", matchedBy: "binding.account" }],
    ];
    for (const [input, expected] of [...checks, ...checks.slice(0, 2)]) {
      expect(
        resolveAgentRoute({ cfg, channel: "telegram", accountId: "default", ...input }),
      ).toMatchObject(expected);
    }
  });
});

describe("binding evaluation cache scalability", () => {
  test("does not rescan full bindings across distinct channel/account cache entries (#36915)", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "agent-0",
          match: {
            channel: "dingtalk",
            accountId: "acct-0",
            peer: { kind: "direct", id: "user-0" },
          },
        },
      ],
    };
    const route = (index: number) =>
      resolveAgentRoute({
        cfg,
        channel: "dingtalk",
        accountId: `acct-${index}`,
        peer: { kind: "direct", id: `user-${index}` },
      });
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
