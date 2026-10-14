import { describe, expect, it } from "vitest";
import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

function cfgWithBindings(matches: AgentRouteBinding["match"][]): OpenClawConfig {
  return {
    bindings: matches.map<AgentRouteBinding>((match) => ({
      type: "route",
      agentId: "bot-alpha",
      match,
    })),
  };
}

function resolveBoundAccount(
  params: Omit<Parameters<typeof resolveFirstBoundAccountId>[0], "agentId" | "channelId"> & {
    channelId?: string;
  },
) {
  return resolveFirstBoundAccountId({ agentId: "bot-alpha", channelId: "matrix", ...params });
}

describe("resolveFirstBoundAccountId", () => {
  it("preserves first-match binding order for peerless callers", () => {
    const cfg = cfgWithBindings([
      {
        channel: "matrix",
        peer: { kind: "channel", id: "*" },
        accountId: "bot-alpha-wildcard",
      },
      { channel: "matrix", accountId: "bot-alpha-default" },
    ]);
    expect(
      resolveBoundAccount({
        cfg,
      }),
    ).toBe("bot-alpha-wildcard");
  });

  it("filters bindings by peer kind when caller supplies peerKind", () => {
    const cfg = cfgWithBindings([
      {
        channel: "matrix",
        peer: { kind: "direct", id: "*" },
        accountId: "bot-alpha-dm",
      },
      {
        channel: "matrix",
        peer: { kind: "channel", id: "*" },
        accountId: "bot-alpha-room",
      },
    ]);
    expect(
      resolveBoundAccount({
        cfg,
        peerId: "!room:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-room");
    expect(
      resolveBoundAccount({
        cfg,
        peerId: "@user:example.org",
        peerKind: "direct",
      }),
    ).toBe("bot-alpha-dm");
  });

  it("treats group and channel peer kinds as equivalent (matches resolve-route semantics)", () => {
    const cfg = cfgWithBindings([
      {
        channel: "line",
        peer: { kind: "group", id: "*" },
        accountId: "bot-alpha-group",
      },
    ]);
    expect(
      resolveBoundAccount({
        cfg,
        channelId: "line",
        peerId: "!roomA:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-group");
    const cfg2 = cfgWithBindings([
      {
        channel: "line",
        peer: { kind: "channel", id: "*" },
        accountId: "bot-alpha-channel",
      },
    ]);
    expect(
      resolveBoundAccount({
        cfg: cfg2,
        channelId: "line",
        peerId: "groupA",
        peerKind: "group",
      }),
    ).toBe("bot-alpha-channel");
  });

  it("skips wildcard peer bindings when the caller's peerKind is unknown", () => {
    const cfg = cfgWithBindings([
      {
        channel: "matrix",
        peer: { kind: "direct", id: "*" },
        accountId: "bot-alpha-dm",
      },
      { channel: "matrix", accountId: "bot-alpha-default" },
    ]);
    expect(
      resolveBoundAccount({
        cfg,
        peerId: "!room:example.org",
      }),
    ).toBe("bot-alpha-default");
  });

  it("matches exact canonical peer aliases before falling back to wildcard bindings", () => {
    const cfg = cfgWithBindings([
      {
        channel: "qa-channel",
        peer: { kind: "channel", id: "*" },
        accountId: "bot-alpha-wildcard",
      },
      {
        channel: "qa-channel",
        peer: { kind: "channel", id: "channel:conversation-a" },
        accountId: "bot-alpha-conversation",
      },
    ]);
    expect(
      resolveBoundAccount({
        cfg,
        channelId: "qa-channel",
        peerId: "conversation-a",
        exactPeerIdAliases: ["channel:conversation-a"],
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-conversation");
  });

  it("skips peer-specific bindings whose kind does not match the caller's peerKind", () => {
    const cfg = cfgWithBindings([
      {
        channel: "matrix",
        peer: { kind: "direct", id: "!room:example.org" },
        accountId: "bot-alpha-wrong-kind",
      },
      { channel: "matrix", accountId: "bot-alpha-default" },
    ]);
    expect(
      resolveBoundAccount({
        cfg,
        peerId: "!room:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-default");
  });

  it("skips scoped bindings when the caller has no matching group space", () => {
    const cfg = cfgWithBindings([
      {
        channel: "discord",
        guildId: "guild-other",
        accountId: "bot-alpha-other-guild",
      },
      { channel: "discord", accountId: "bot-alpha-default" },
    ]);

    expect(
      resolveBoundAccount({
        cfg,
        channelId: "discord",
        groupSpace: "guild-current",
      }),
    ).toBe("bot-alpha-default");
  });

  it("matches scoped guild and team bindings against caller group space", () => {
    const cfg = cfgWithBindings([
      {
        channel: "discord",
        guildId: "guild-current",
        accountId: "bot-alpha-guild",
      },
      {
        channel: "slack",
        teamId: "team-current",
        accountId: "bot-alpha-team",
      },
    ]);

    expect(
      resolveBoundAccount({
        cfg,
        channelId: "discord",
        groupSpace: "guild-current",
      }),
    ).toBe("bot-alpha-guild");
    expect(
      resolveBoundAccount({
        cfg,
        channelId: "slack",
        groupSpace: "team-current",
      }),
    ).toBe("bot-alpha-team");
  });

  it("requires caller roles before selecting role-scoped bindings", () => {
    const cfg = cfgWithBindings([
      {
        channel: "discord",
        guildId: "guild-current",
        roles: ["admin"],
        accountId: "bot-alpha-admin",
      },
      { channel: "discord", accountId: "bot-alpha-default" },
    ]);

    expect(
      resolveBoundAccount({
        cfg,
        channelId: "discord",
        groupSpace: "guild-current",
        memberRoleIds: ["member"],
      }),
    ).toBe("bot-alpha-default");
    expect(
      resolveBoundAccount({
        cfg,
        channelId: "discord",
        groupSpace: "guild-current",
        memberRoleIds: ["admin"],
      }),
    ).toBe("bot-alpha-admin");
  });
});
