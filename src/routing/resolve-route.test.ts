import { describe, expect, test } from "vitest";
import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/config.js";
import { BindingsSchema } from "../config/zod-schema.agents.js";
import { resolveAgentRoute } from "./resolve-route.js";

describe("resolveAgentRoute", () => {
  test("defaults to main/default when no bindings exist", () => {
    const cfg: OpenClawConfig = {};
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: null,
      peer: { kind: "direct", id: "+15551234567" },
    });
    expect(route.agentId).toBe("main");
    expect(route.accountId).toBe("default");
    expect(route.sessionKey).toBe("agent:main:main");
    expect(route.matchedBy).toBe("default");
  });

  test("dmScope=per-peer isolates DM sessions by sender id", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "per-peer" },
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: null,
      peer: { kind: "direct", id: "+15551234567" },
    });
    expect(route.sessionKey).toBe("agent:main:direct:+15551234567");
  });

  test("dmScope=per-channel-peer isolates DM sessions per channel and sender", () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "per-channel-peer" },
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: null,
      peer: { kind: "direct", id: "+15551234567" },
    });
    expect(route.sessionKey).toBe("agent:main:whatsapp:direct:+15551234567");
  });

  test("identityLinks collapses per-peer DM sessions across providers", () => {
    const cfg: OpenClawConfig = {
      session: {
        dmScope: "per-peer",
        identityLinks: {
          alice: ["telegram:111111111", "discord:222222222222222222"],
        },
      },
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      accountId: null,
      peer: { kind: "direct", id: "111111111" },
    });
    expect(route.sessionKey).toBe("agent:main:direct:alice");
  });

  test("identityLinks applies to per-channel-peer DM sessions", () => {
    const cfg: OpenClawConfig = {
      session: {
        dmScope: "per-channel-peer",
        identityLinks: {
          alice: ["telegram:111111111", "discord:222222222222222222"],
        },
      },
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: null,
      peer: { kind: "direct", id: "222222222222222222" },
    });
    expect(route.sessionKey).toBe("agent:main:discord:direct:alice");
  });

  test("peer binding wins over account binding", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "a",
          match: {
            channel: "whatsapp",
            accountId: "biz",
            peer: { kind: "direct", id: "+1000" },
          },
        },
        {
          agentId: "b",
          match: { channel: "whatsapp", accountId: "biz" },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: "biz",
      peer: { kind: "direct", id: "+1000" },
    });
    expect(route.agentId).toBe("a");
    expect(route.sessionKey).toBe("agent:a:main");
    expect(route.matchedBy).toBe("binding.peer");
  });

  test("discord channel peer binding wins over guild binding", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "chan",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "c1" },
          },
        },
        {
          agentId: "guild",
          match: {
            channel: "discord",
            accountId: "default",
            guildId: "g1",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "channel", id: "c1" },
      guildId: "g1",
    });
    expect(route.agentId).toBe("chan");
    expect(route.sessionKey).toBe("agent:chan:discord:channel:c1");
    expect(route.matchedBy).toBe("binding.peer");
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

  test("guild binding wins over account binding when peer not bound", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "guild",
          match: {
            channel: "discord",
            accountId: "default",
            guildId: "g1",
          },
        },
        {
          agentId: "acct",
          match: { channel: "discord", accountId: "default" },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "default",
      peer: { kind: "channel", id: "c1" },
      guildId: "g1",
    });
    expect(route.agentId).toBe("guild");
    expect(route.matchedBy).toBe("binding.guild");
  });

  test("peer+guild binding does not act as guild-wide fallback when peer mismatches (#14752)", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "olga",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "CHANNEL_A" },
            guildId: "GUILD_1",
          },
        },
        {
          agentId: "main",
          match: {
            channel: "discord",
            guildId: "GUILD_1",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "CHANNEL_B" },
      guildId: "GUILD_1",
    });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("binding.guild");
  });

  test("peer+guild binding requires guild match even when peer matches", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "wrongguild",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "c1" },
            guildId: "g1",
          },
        },
        {
          agentId: "rightguild",
          match: {
            channel: "discord",
            guildId: "g2",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "c1" },
      guildId: "g2",
    });
    expect(route.agentId).toBe("rightguild");
    expect(route.matchedBy).toBe("binding.guild");
  });

  test("peer+team binding does not act as team-wide fallback when peer mismatches", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "roomonly",
          match: {
            channel: "slack",
            peer: { kind: "channel", id: "C_A" },
            teamId: "T1",
          },
        },
        {
          agentId: "teamwide",
          match: {
            channel: "slack",
            teamId: "T1",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "slack",
      teamId: "T1",
      peer: { kind: "channel", id: "C_B" },
    });
    expect(route.agentId).toBe("teamwide");
    expect(route.matchedBy).toBe("binding.team");
  });

  test("peer+team binding requires team match even when peer matches", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "wrongteam",
          match: {
            channel: "slack",
            peer: { kind: "channel", id: "C1" },
            teamId: "T1",
          },
        },
        {
          agentId: "rightteam",
          match: {
            channel: "slack",
            teamId: "T2",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "slack",
      teamId: "T2",
      peer: { kind: "channel", id: "C1" },
    });
    expect(route.agentId).toBe("rightteam");
    expect(route.matchedBy).toBe("binding.team");
  });

  test("missing accountId in binding matches default account only", () => {
    const cfg: OpenClawConfig = {
      bindings: [{ agentId: "defaultAcct", match: { channel: "whatsapp" } }],
    };

    const defaultRoute = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: undefined,
      peer: { kind: "direct", id: "+1000" },
    });
    expect(defaultRoute.agentId).toBe("defaultacct");
    expect(defaultRoute.matchedBy).toBe("binding.account");

    const otherRoute = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: "biz",
      peer: { kind: "direct", id: "+1000" },
    });
    expect(otherRoute.agentId).toBe("main");
  });

  test("accountId=* matches any account as a channel fallback", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "any",
          match: { channel: "whatsapp", accountId: "*" },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: "biz",
      peer: { kind: "direct", id: "+1000" },
    });
    expect(route.agentId).toBe("any");
    expect(route.matchedBy).toBe("binding.channel");
  });

  test("defaultAgentId is used when no binding matches", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "home", default: true, workspace: "~/openclaw-home" }],
      },
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: "biz",
      peer: { kind: "direct", id: "+1000" },
    });
    expect(route.agentId).toBe("home");
    expect(route.sessionKey).toBe("agent:home:main");
  });
});

test("dmScope=per-account-channel-peer isolates DM sessions per account, channel and sender", () => {
  const cfg: OpenClawConfig = {
    session: { dmScope: "per-account-channel-peer" },
  };
  const route = resolveAgentRoute({
    cfg,
    channel: "telegram",
    accountId: "tasks",
    peer: { kind: "direct", id: "7550356539" },
  });
  expect(route.sessionKey).toBe("agent:main:telegram:tasks:direct:7550356539");
});

test("dmScope=per-account-channel-peer uses default accountId when not provided", () => {
  const cfg: OpenClawConfig = {
    session: { dmScope: "per-account-channel-peer" },
  };
  const route = resolveAgentRoute({
    cfg,
    channel: "telegram",
    accountId: null,
    peer: { kind: "direct", id: "7550356539" },
  });
  expect(route.sessionKey).toBe("agent:main:telegram:default:direct:7550356539");
});

describe("parentPeer binding inheritance (thread support)", () => {
  const threadPeer = { kind: "channel" as const, id: "thread-456" };
  const defaultParentPeer = { kind: "channel" as const, id: "parent-channel-123" };

  function makeDiscordPeerBinding(agentId: string, peerId: string) {
    return {
      agentId,
      match: {
        channel: "discord" as const,
        peer: { kind: "channel" as const, id: peerId },
      },
    };
  }

  function makeDiscordGuildBinding(agentId: string, guildId: string) {
    return {
      agentId,
      match: {
        channel: "discord" as const,
        guildId,
      },
    };
  }

  function resolveDiscordThreadRoute(params: {
    cfg: OpenClawConfig;
    parentPeer?: { kind: "channel"; id: string } | null;
    guildId?: string;
  }) {
    const parentPeer = "parentPeer" in params ? params.parentPeer : defaultParentPeer;
    return resolveAgentRoute({
      cfg: params.cfg,
      channel: "discord",
      peer: threadPeer,
      parentPeer,
      guildId: params.guildId,
    });
  }

  test("thread inherits binding from parent channel when no direct match", () => {
    const cfg: OpenClawConfig = {
      bindings: [makeDiscordPeerBinding("adecco", defaultParentPeer.id)],
    };
    const route = resolveDiscordThreadRoute({ cfg });
    expect(route.agentId).toBe("adecco");
    expect(route.matchedBy).toBe("binding.peer.parent");
  });

  test("direct peer binding wins over parent peer binding", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        makeDiscordPeerBinding("thread-agent", threadPeer.id),
        makeDiscordPeerBinding("parent-agent", defaultParentPeer.id),
      ],
    };
    const route = resolveDiscordThreadRoute({ cfg });
    expect(route.agentId).toBe("thread-agent");
    expect(route.matchedBy).toBe("binding.peer");
  });

  test("parent peer binding wins over guild binding", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        makeDiscordPeerBinding("parent-agent", defaultParentPeer.id),
        makeDiscordGuildBinding("guild-agent", "guild-789"),
      ],
    };
    const route = resolveDiscordThreadRoute({ cfg, guildId: "guild-789" });
    expect(route.agentId).toBe("parent-agent");
    expect(route.matchedBy).toBe("binding.peer.parent");
  });

  test("falls back to guild binding when no parent peer match", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        makeDiscordPeerBinding("other-parent-agent", "other-parent-999"),
        makeDiscordGuildBinding("guild-agent", "guild-789"),
      ],
    };
    const route = resolveDiscordThreadRoute({ cfg, guildId: "guild-789" });
    expect(route.agentId).toBe("guild-agent");
    expect(route.matchedBy).toBe("binding.guild");
  });

  test("parentPeer with empty id is ignored", () => {
    const cfg: OpenClawConfig = {
      bindings: [makeDiscordPeerBinding("parent-agent", defaultParentPeer.id)],
    };
    const route = resolveDiscordThreadRoute({ cfg, parentPeer: { kind: "channel", id: "" } });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("default");
  });

  test("null parentPeer is handled gracefully", () => {
    const cfg: OpenClawConfig = {
      bindings: [makeDiscordPeerBinding("parent-agent", defaultParentPeer.id)],
    };
    const route = resolveDiscordThreadRoute({ cfg, parentPeer: null });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("default");
  });
});

describe("backward compatibility: peer.kind dm → direct", () => {
  test("legacy dm in config matches runtime direct peer", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "alex",
          match: {
            channel: "whatsapp",
            // Legacy config uses "dm" instead of "direct"
            peer: { kind: "dm" as ChatType, id: "+15551234567" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: null,
      // Runtime uses canonical "direct"
      peer: { kind: "direct", id: "+15551234567" },
    });
    expect(route.agentId).toBe("alex");
    expect(route.matchedBy).toBe("binding.peer");
  });
});

describe("role-based agent routing", () => {
  type DiscordBinding = NonNullable<OpenClawConfig["bindings"]>[number];

  function makeDiscordRoleBinding(
    agentId: string,
    params: {
      roles?: string[];
      peerId?: string;
      includeGuildId?: boolean;
    } = {},
  ): DiscordBinding {
    return {
      agentId,
      match: {
        channel: "discord",
        ...(params.includeGuildId === false ? {} : { guildId: "g1" }),
        ...(params.roles !== undefined ? { roles: params.roles } : {}),
        ...(params.peerId ? { peer: { kind: "channel", id: params.peerId } } : {}),
      },
    };
  }

  function expectDiscordRoleRoute(params: {
    bindings: DiscordBinding[];
    memberRoleIds?: string[];
    peerId?: string;
    parentPeerId?: string;
    expectedAgentId: string;
    expectedMatchedBy: string;
  }) {
    const route = resolveAgentRoute({
      cfg: { bindings: params.bindings },
      channel: "discord",
      guildId: "g1",
      ...(params.memberRoleIds ? { memberRoleIds: params.memberRoleIds } : {}),
      peer: { kind: "channel", id: params.peerId ?? "c1" },
      ...(params.parentPeerId
        ? {
            parentPeer: { kind: "channel", id: params.parentPeerId },
          }
        : {}),
    });
    expect(route.agentId).toBe(params.expectedAgentId);
    expect(route.matchedBy).toBe(params.expectedMatchedBy);
  }

  test("guild+roles binding matches when member has matching role", () => {
    expectDiscordRoleRoute({
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      memberRoleIds: ["r1"],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
    });
  });

  test("guild+roles binding skipped when no matching role", () => {
    expectDiscordRoleRoute({
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      memberRoleIds: ["r2"],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    });
  });

  test("guild+roles is more specific than guild-only", () => {
    expectDiscordRoleRoute({
      bindings: [
        makeDiscordRoleBinding("opus", { roles: ["r1"] }),
        makeDiscordRoleBinding("sonnet"),
      ],
      memberRoleIds: ["r1"],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
    });
  });

  test("peer binding still beats guild+roles", () => {
    expectDiscordRoleRoute({
      bindings: [
        makeDiscordRoleBinding("peer-agent", { peerId: "c1", includeGuildId: false }),
        makeDiscordRoleBinding("roles-agent", { roles: ["r1"] }),
      ],
      memberRoleIds: ["r1"],
      expectedAgentId: "peer-agent",
      expectedMatchedBy: "binding.peer",
    });
  });

  test("parent peer binding still beats guild+roles", () => {
    expectDiscordRoleRoute({
      bindings: [
        makeDiscordRoleBinding("parent-agent", {
          peerId: "parent-1",
          includeGuildId: false,
        }),
        makeDiscordRoleBinding("roles-agent", { roles: ["r1"] }),
      ],
      memberRoleIds: ["r1"],
      peerId: "thread-1",
      parentPeerId: "parent-1",
      expectedAgentId: "parent-agent",
      expectedMatchedBy: "binding.peer.parent",
    });
  });

  test("no memberRoleIds means guild+roles doesn't match", () => {
    expectDiscordRoleRoute({
      bindings: [makeDiscordRoleBinding("opus", { roles: ["r1"] })],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    });
  });

  test("first matching binding wins with multiple role bindings", () => {
    expectDiscordRoleRoute({
      bindings: [
        makeDiscordRoleBinding("opus", { roles: ["r1"] }),
        makeDiscordRoleBinding("sonnet", { roles: ["r2"] }),
      ],
      memberRoleIds: ["r1", "r2"],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild+roles",
    });
  });

  test("empty roles array treated as no role restriction", () => {
    expectDiscordRoleRoute({
      bindings: [makeDiscordRoleBinding("opus", { roles: [] })],
      memberRoleIds: ["r1"],
      expectedAgentId: "opus",
      expectedMatchedBy: "binding.guild",
    });
  });

  test("guild+roles binding does not match as guild-only when roles do not match", () => {
    expectDiscordRoleRoute({
      bindings: [makeDiscordRoleBinding("opus", { roles: ["admin"] })],
      memberRoleIds: ["regular"],
      expectedAgentId: "main",
      expectedMatchedBy: "default",
    });
  });

  test("peer+guild+roles binding does not act as guild+roles fallback when peer mismatches", () => {
    expectDiscordRoleRoute({
      bindings: [
        makeDiscordRoleBinding("peer-roles", { peerId: "c-target", roles: ["r1"] }),
        makeDiscordRoleBinding("guild-roles", { roles: ["r1"] }),
      ],
      memberRoleIds: ["r1"],
      peerId: "c-other",
      expectedAgentId: "guild-roles",
      expectedMatchedBy: "binding.guild+roles",
    });
  });
});

describe("binding sessionKey/sessionScope override", () => {
  test("sessionKey=main on peer binding collapses to main session", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "atlas",
          match: {
            channel: "discord",
            accountId: "atlas",
            peer: { kind: "channel", id: "private-room-1" },
          },
          sessionKey: "main",
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "atlas",
      peer: { kind: "channel", id: "private-room-1" },
    });
    expect(route.agentId).toBe("atlas");
    expect(route.matchedBy).toBe("binding.peer");
    expect(route.sessionKey).toBe(route.mainSessionKey);
    expect(route.sessionKey).toBe("agent:atlas:main");
  });

  test("sessionScope=main alias works the same as sessionKey", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "pip",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "control-room" },
          },
          sessionScope: "main",
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "control-room" },
    });
    expect(route.agentId).toBe("pip");
    expect(route.sessionKey).toBe(route.mainSessionKey);
    expect(route.sessionKey).toBe("agent:pip:main");
  });

  test("both sessionKey and sessionScope set to main works (sessionKey wins)", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "both",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "c1" },
          },
          sessionKey: "main",
          sessionScope: "main",
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "c1" },
    });
    expect(route.sessionKey).toBe(route.mainSessionKey);
  });

  test("binding without override preserves per-channel/peer session key", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "atlas",
          match: {
            channel: "discord",
            accountId: "atlas",
            peer: { kind: "channel", id: "private-room-1" },
          },
          // no sessionKey or sessionScope
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      accountId: "atlas",
      peer: { kind: "channel", id: "private-room-1" },
    });
    expect(route.agentId).toBe("atlas");
    expect(route.matchedBy).toBe("binding.peer");
    // Without override, group/channel peers get a per-peer session key
    expect(route.sessionKey).toBe("agent:atlas:discord:channel:private-room-1");
    expect(route.sessionKey).not.toBe(route.mainSessionKey);
  });

  test("parent-peer binding with sessionKey=main collapses to main session", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "atlas",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "parent-channel-100" },
          },
          sessionKey: "main",
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "thread-200" },
      parentPeer: { kind: "channel", id: "parent-channel-100" },
    });
    expect(route.agentId).toBe("atlas");
    expect(route.matchedBy).toBe("binding.peer.parent");
    expect(route.sessionKey).toBe(route.mainSessionKey);
    expect(route.sessionKey).toBe("agent:atlas:main");
  });

  test("sessionKey override does not change tier precedence (peer > guild)", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "peer-agent",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "c1" },
          },
          sessionKey: "main",
        },
        {
          agentId: "guild-agent",
          match: {
            channel: "discord",
            guildId: "g1",
          },
        },
      ],
    };
    // peer binding should still win over guild binding
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "c1" },
      guildId: "g1",
    });
    expect(route.agentId).toBe("peer-agent");
    expect(route.matchedBy).toBe("binding.peer");
    expect(route.sessionKey).toBe("agent:peer-agent:main");
  });

  test("guild binding with sessionKey=main collapses to main session", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "guild-main",
          match: {
            channel: "discord",
            guildId: "g1",
          },
          sessionKey: "main",
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      guildId: "g1",
      peer: { kind: "channel", id: "any-channel" },
    });
    expect(route.agentId).toBe("guild-main");
    expect(route.matchedBy).toBe("binding.guild");
    expect(route.sessionKey).toBe(route.mainSessionKey);
  });

  test("default route (no binding match) is unaffected by override on other bindings", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "atlas",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "specific-room" },
          },
          sessionKey: "main",
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "telegram",
      peer: { kind: "group", id: "group-1" },
    });
    expect(route.matchedBy).toBe("default");
    expect(route.sessionKey).toBe("agent:main:telegram:group:group-1");
    expect(route.sessionKey).not.toBe(route.mainSessionKey);
  });
});

describe("BindingsSchema sessionKey/sessionScope validation", () => {
  test("accepts sessionKey: 'main'", () => {
    const result = BindingsSchema.safeParse([
      {
        agentId: "atlas",
        match: { channel: "discord", peer: { kind: "channel", id: "c1" } },
        sessionKey: "main",
      },
    ]);
    expect(result.success).toBe(true);
  });

  test("accepts sessionScope: 'main'", () => {
    const result = BindingsSchema.safeParse([
      {
        agentId: "atlas",
        match: { channel: "discord" },
        sessionScope: "main",
      },
    ]);
    expect(result.success).toBe(true);
  });

  test("accepts both sessionKey and sessionScope together", () => {
    const result = BindingsSchema.safeParse([
      {
        agentId: "atlas",
        match: { channel: "discord" },
        sessionKey: "main",
        sessionScope: "main",
      },
    ]);
    expect(result.success).toBe(true);
  });

  test("accepts binding without sessionKey or sessionScope", () => {
    const result = BindingsSchema.safeParse([
      {
        agentId: "atlas",
        match: { channel: "discord" },
      },
    ]);
    expect(result.success).toBe(true);
  });

  test("rejects invalid sessionKey value", () => {
    const result = BindingsSchema.safeParse([
      {
        agentId: "atlas",
        match: { channel: "discord" },
        sessionKey: "global",
      },
    ]);
    expect(result.success).toBe(false);
  });

  test("rejects invalid sessionScope value", () => {
    const result = BindingsSchema.safeParse([
      {
        agentId: "atlas",
        match: { channel: "discord" },
        sessionScope: "per-peer",
      },
    ]);
    expect(result.success).toBe(false);
  });
});
