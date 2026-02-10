import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
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
  test("thread inherits binding from parent channel when no direct match", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "adecco",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "parent-channel-123" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "thread-456" },
      parentPeer: { kind: "channel", id: "parent-channel-123" },
    });
    expect(route.agentId).toBe("adecco");
    expect(route.matchedBy).toBe("binding.peer.parent");
  });

  test("direct peer binding wins over parent peer binding", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "thread-agent",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "thread-456" },
          },
        },
        {
          agentId: "parent-agent",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "parent-channel-123" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "thread-456" },
      parentPeer: { kind: "channel", id: "parent-channel-123" },
    });
    expect(route.agentId).toBe("thread-agent");
    expect(route.matchedBy).toBe("binding.peer");
  });

  test("parent peer binding wins over guild binding", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "parent-agent",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "parent-channel-123" },
          },
        },
        {
          agentId: "guild-agent",
          match: {
            channel: "discord",
            guildId: "guild-789",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "thread-456" },
      parentPeer: { kind: "channel", id: "parent-channel-123" },
      guildId: "guild-789",
    });
    expect(route.agentId).toBe("parent-agent");
    expect(route.matchedBy).toBe("binding.peer.parent");
  });

  test("falls back to guild binding when no parent peer match", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "other-parent-agent",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "other-parent-999" },
          },
        },
        {
          agentId: "guild-agent",
          match: {
            channel: "discord",
            guildId: "guild-789",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "thread-456" },
      parentPeer: { kind: "channel", id: "parent-channel-123" },
      guildId: "guild-789",
    });
    expect(route.agentId).toBe("guild-agent");
    expect(route.matchedBy).toBe("binding.guild");
  });

  test("parentPeer with empty id is ignored", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "parent-agent",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "parent-channel-123" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "thread-456" },
      parentPeer: { kind: "channel", id: "" },
    });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("default");
  });

  test("null parentPeer is handled gracefully", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "parent-agent",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "parent-channel-123" },
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "thread-456" },
      parentPeer: null,
    });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("default");
  });
});

describe("discord role mention routing", () => {
  test("routes by first matching mentioned role in an unbound channel", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "guild-fallback",
          match: {
            channel: "discord",
            guildId: "g1",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      guildId: "g1",
      peer: { kind: "channel", id: "unbound-channel" },
      mentionedRoleIds: ["r-storm", "r-hunter"],
      roleBindings: {
        "r-storm": "storm",
        "r-hunter": "hunter",
      },
    });
    expect(route.agentId).toBe("storm");
    expect(route.matchedBy).toBe("binding.role");
  });

  test("peer binding still wins over role mention", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "storm",
          match: {
            channel: "discord",
            peer: { kind: "channel", id: "storm-chat" },
          },
        },
        {
          agentId: "guild-fallback",
          match: {
            channel: "discord",
            guildId: "g1",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      guildId: "g1",
      peer: { kind: "channel", id: "storm-chat" },
      mentionedRoleIds: ["r-hunter"],
      roleBindings: {
        "r-hunter": "hunter",
      },
    });
    expect(route.agentId).toBe("storm");
    expect(route.matchedBy).toBe("binding.peer");
  });

  test("role mention wins over guild fallback when peer is not bound", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "guild-fallback",
          match: {
            channel: "discord",
            guildId: "g1",
          },
        },
      ],
    };
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      guildId: "g1",
      peer: { kind: "channel", id: "random-channel" },
      mentionedRoleIds: ["r-hunter"],
      roleBindings: {
        "r-hunter": "hunter",
      },
    });
    expect(route.agentId).toBe("hunter");
    expect(route.matchedBy).toBe("binding.role");
  });

  test("falls back when role mentions do not map to an agent", () => {
    const cfg: OpenClawConfig = {};
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "random-channel" },
      mentionedRoleIds: ["r-unknown"],
      roleBindings: {
        "r-storm": "storm",
      },
    });
    expect(route.agentId).toBe("main");
    expect(route.matchedBy).toBe("default");
  });

  test("uses default agent in an unbound channel with no role mentions", () => {
    const cfg: OpenClawConfig = {};
    const route = resolveAgentRoute({
      cfg,
      channel: "discord",
      peer: { kind: "channel", id: "random-channel" },
      roleBindings: {
        "r-storm": "storm",
      },
    });
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
            peer: { kind: "dm", id: "+15551234567" },
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
