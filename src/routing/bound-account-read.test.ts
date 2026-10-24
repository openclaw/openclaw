import { describe, expect, it } from "vitest";
import type { AgentRouteBinding } from "../config/types.agents.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

type Match = AgentRouteBinding["match"];
function binding(accountId: string, match: Omit<Match, "accountId">): Match {
  return { accountId, ...match };
}

function resolveBoundAccount(
  matches: Match[],
  params: Omit<
    Parameters<typeof resolveFirstBoundAccountId>[0],
    "cfg" | "agentId" | "channelId"
  > & {
    channelId?: string;
  } = {},
) {
  return resolveFirstBoundAccountId({
    agentId: "bot-alpha",
    channelId: "matrix",
    ...params,
    cfg: { bindings: matches.map((match) => ({ type: "route", agentId: "bot-alpha", match })) },
  });
}

describe("resolveFirstBoundAccountId", () => {
  it("preserves first-match binding order for peerless callers", () => {
    expect(
      resolveBoundAccount([
        binding("bot-alpha-wildcard", { channel: "matrix", peer: { kind: "channel", id: "*" } }),
        binding("bot-alpha-default", { channel: "matrix" }),
      ]),
    ).toBe("bot-alpha-wildcard");
  });

  it("filters bindings by peer kind when caller supplies peerKind", () => {
    const matches = [
      binding("bot-alpha-dm", { channel: "matrix", peer: { kind: "direct", id: "*" } }),
      binding("bot-alpha-room", { channel: "matrix", peer: { kind: "channel", id: "*" } }),
    ];
    expect(resolveBoundAccount(matches, { peerId: "!room:example.org", peerKind: "channel" })).toBe(
      "bot-alpha-room",
    );
    expect(resolveBoundAccount(matches, { peerId: "@user:example.org", peerKind: "direct" })).toBe(
      "bot-alpha-dm",
    );
  });

  it("treats group and channel peer kinds as equivalent (matches resolve-route semantics)", () => {
    expect(
      resolveBoundAccount(
        [binding("bot-alpha-group", { channel: "line", peer: { kind: "group", id: "*" } })],
        { channelId: "line", peerId: "!roomA:example.org", peerKind: "channel" },
      ),
    ).toBe("bot-alpha-group");
    expect(
      resolveBoundAccount(
        [binding("bot-alpha-channel", { channel: "line", peer: { kind: "channel", id: "*" } })],
        { channelId: "line", peerId: "groupA", peerKind: "group" },
      ),
    ).toBe("bot-alpha-channel");
  });

  it("skips wildcard peer bindings when the caller's peerKind is unknown", () => {
    expect(
      resolveBoundAccount(
        [
          binding("bot-alpha-dm", { channel: "matrix", peer: { kind: "direct", id: "*" } }),
          binding("bot-alpha-default", { channel: "matrix" }),
        ],
        { peerId: "!room:example.org" },
      ),
    ).toBe("bot-alpha-default");
  });

  it("matches exact canonical peer aliases before falling back to wildcard bindings", () => {
    expect(
      resolveBoundAccount(
        [
          binding("bot-alpha-wildcard", {
            channel: "qa-channel",
            peer: { kind: "channel", id: "*" },
          }),
          binding("bot-alpha-conversation", {
            channel: "qa-channel",
            peer: { kind: "channel", id: "channel:conversation-a" },
          }),
        ],
        {
          channelId: "qa-channel",
          peerId: "conversation-a",
          exactPeerIdAliases: ["channel:conversation-a"],
          peerKind: "channel",
        },
      ),
    ).toBe("bot-alpha-conversation");
  });

  it("skips peer-specific bindings whose kind does not match the caller's peerKind", () => {
    expect(
      resolveBoundAccount(
        [
          binding("bot-alpha-wrong-kind", {
            channel: "matrix",
            peer: { kind: "direct", id: "!room:example.org" },
          }),
          binding("bot-alpha-default", { channel: "matrix" }),
        ],
        { peerId: "!room:example.org", peerKind: "channel" },
      ),
    ).toBe("bot-alpha-default");
  });

  it("skips scoped bindings when the caller has no matching group space", () => {
    expect(
      resolveBoundAccount(
        [
          binding("bot-alpha-other-guild", { channel: "discord", guildId: "guild-other" }),
          binding("bot-alpha-default", { channel: "discord" }),
        ],
        { channelId: "discord", groupSpace: "guild-current" },
      ),
    ).toBe("bot-alpha-default");
  });

  it("matches scoped guild and team bindings against caller group space", () => {
    const matches = [
      binding("bot-alpha-guild", { channel: "discord", guildId: "guild-current" }),
      binding("bot-alpha-team", { channel: "slack", teamId: "team-current" }),
    ];
    expect(
      resolveBoundAccount(matches, { channelId: "discord", groupSpace: "guild-current" }),
    ).toBe("bot-alpha-guild");
    expect(resolveBoundAccount(matches, { channelId: "slack", groupSpace: "team-current" })).toBe(
      "bot-alpha-team",
    );
  });

  it("requires caller roles before selecting role-scoped bindings", () => {
    const matches = [
      binding("bot-alpha-admin", {
        channel: "discord",
        guildId: "guild-current",
        roles: ["admin"],
      }),
      binding("bot-alpha-default", { channel: "discord" }),
    ];
    const scope = { channelId: "discord", groupSpace: "guild-current" };
    expect(resolveBoundAccount(matches, { ...scope, memberRoleIds: ["member"] })).toBe(
      "bot-alpha-default",
    );
    expect(resolveBoundAccount(matches, { ...scope, memberRoleIds: ["admin"] })).toBe(
      "bot-alpha-admin",
    );
  });
});
