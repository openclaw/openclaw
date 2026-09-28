import { describe, expect, test, vi } from "vitest";
import * as configBindings from "../config/bindings.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRoute } from "./resolve-route.js";

describe("resolved route cache keys", () => {
  test("keeps cached routes independent of returned route mutations", () => {
    const input: Parameters<typeof resolveAgentRoute>[0] = {
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

  test("does not reuse a cached route when peer and guild fields contain cache separators", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "whole-peer" }, { id: "guild-room" }] },
      bindings: [
        {
          agentId: "whole-peer",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "group", id: "room\t-\tguild-1" },
          },
        },
        {
          agentId: "guild-room",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "group", id: "room" },
            guildId: "guild-1",
          },
        },
      ],
    };

    expect(
      resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "default",
        peer: { kind: "group", id: "room\t-\tguild-1" },
      }),
    ).toMatchObject({ agentId: "whole-peer", matchedBy: "binding.peer" });
    expect(
      resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "default",
        guildId: "guild-1",
        peer: { kind: "group", id: "room" },
      }),
    ).toMatchObject({ agentId: "guild-room", matchedBy: "binding.peer" });
  });

  test("does not reuse a cached route when role IDs contain cache separators", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "comma-role" }, { id: "suffix-role" }] },
      bindings: [
        {
          agentId: "comma-role",
          match: {
            channel: "discord",
            accountId: "default",
            guildId: "guild-1",
            roles: ["a,b"],
          },
        },
        {
          agentId: "suffix-role",
          match: {
            channel: "discord",
            accountId: "default",
            guildId: "guild-1",
            roles: ["b,c"],
          },
        },
      ],
    };

    expect(
      resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "default",
        guildId: "guild-1",
        memberRoleIds: ["a,b", "c"],
      }),
    ).toMatchObject({ agentId: "comma-role", matchedBy: "binding.guild+roles" });
    expect(
      resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "default",
        guildId: "guild-1",
        memberRoleIds: ["a", "b,c"],
      }),
    ).toMatchObject({ agentId: "suffix-role", matchedBy: "binding.guild+roles" });
  });

  test("does not reuse a cached route when guildId is omitted versus the literal hyphen string", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "hyphen-guild" }] },
      bindings: [
        {
          agentId: "hyphen-guild",
          match: {
            channel: "discord",
            accountId: "default",
            guildId: "-",
          },
        },
      ],
    };

    expect(
      resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "default",
        peer: { kind: "group", id: "room" },
      }),
    ).toMatchObject({ agentId: "main", matchedBy: "default" });
    expect(
      resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "default",
        peer: { kind: "group", id: "room" },
        guildId: "-",
      }),
    ).toMatchObject({ agentId: "hyphen-guild", matchedBy: "binding.guild" });
  });

  test("keeps peer presence, kind, and id distinct across cached route tiers", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "channel-wide" },
          { id: "account-wide" },
          { id: "any-direct" },
          { id: "any-group" },
          { id: "known-direct" },
        ],
      },
      bindings: [
        {
          agentId: "known-direct",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "direct", id: "known" },
          },
        },
        {
          agentId: "any-direct",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "direct", id: "*" },
          },
        },
        {
          agentId: "any-group",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "*" },
          },
        },
        {
          agentId: "account-wide",
          match: { channel: "telegram", accountId: "work" },
        },
        {
          agentId: "channel-wide",
          match: { channel: "telegram", accountId: "*" },
        },
      ],
    };

    expect(resolveAgentRoute({ cfg, channel: "telegram", accountId: "default" })).toMatchObject({
      agentId: "channel-wide",
      matchedBy: "binding.channel",
    });
    expect(
      resolveAgentRoute({
        cfg,
        channel: "telegram",
        accountId: "default",
        peer: { kind: "direct", id: "" },
      }),
    ).toMatchObject({ agentId: "any-direct", matchedBy: "binding.peer.wildcard" });
    expect(
      resolveAgentRoute({
        cfg,
        channel: "telegram",
        accountId: "default",
        peer: { kind: "group", id: "" },
      }),
    ).toMatchObject({
      agentId: "any-group",
      matchedBy: "binding.peer.wildcard",
      sessionKey: "agent:any-group:telegram:group:unknown",
    });
    expect(
      resolveAgentRoute({
        cfg,
        channel: "telegram",
        accountId: "default",
        peer: { kind: "direct", id: "known" },
      }),
    ).toMatchObject({ agentId: "known-direct", matchedBy: "binding.peer" });
    expect(resolveAgentRoute({ cfg, channel: "telegram", accountId: "work" })).toMatchObject({
      agentId: "account-wide",
      matchedBy: "binding.account",
    });
    expect(resolveAgentRoute({ cfg, channel: "telegram", accountId: "default" })).toMatchObject({
      agentId: "channel-wide",
      matchedBy: "binding.channel",
    });
    expect(
      resolveAgentRoute({
        cfg,
        channel: "telegram",
        accountId: "default",
        peer: { kind: "direct", id: "" },
      }),
    ).toMatchObject({ agentId: "any-direct", matchedBy: "binding.peer.wildcard" });
  });
});

describe("binding evaluation cache scalability", () => {
  test("does not rescan full bindings across distinct channel/account cache entries (#36915)", () => {
    const cacheKeyCount = 64;
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
    const listBindingsSpy = vi.spyOn(configBindings, "listRouteBindings");
    try {
      const boundRoute = resolveAgentRoute({
        cfg,
        channel: "dingtalk",
        accountId: "acct-0",
        peer: { kind: "direct", id: "user-0" },
      });
      expect(boundRoute.agentId).toBe("agent-0");
      expect(boundRoute.matchedBy).toBe("binding.peer");

      for (let idx = 1; idx < cacheKeyCount; idx += 1) {
        const route = resolveAgentRoute({
          cfg,
          channel: "dingtalk",
          accountId: `acct-${idx}`,
          peer: { kind: "direct", id: `user-${idx}` },
        });
        expect(route.agentId).toBe("main");
        expect(route.matchedBy).toBe("default");
      }

      const repeated = resolveAgentRoute({
        cfg,
        channel: "dingtalk",
        accountId: "acct-0",
        peer: { kind: "direct", id: "user-0" },
      });
      expect(repeated.agentId).toBe("agent-0");
      expect(listBindingsSpy).toHaveBeenCalledTimes(1);
    } finally {
      listBindingsSpy.mockRestore();
    }
  });
});
