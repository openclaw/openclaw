import { expect, it } from "vitest";
import type { AgentRouteBinding } from "../config/types.agents.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

type Match = AgentRouteBinding["match"];
type Scope = Omit<
  Parameters<typeof resolveFirstBoundAccountId>[0],
  "cfg" | "agentId" | "channelId"
>;
const binding = (accountId: string, match: Partial<Match> = {}): Match => ({
  channel: "qa-channel",
  accountId,
  ...match,
});
const peer = (accountId: string, kind: NonNullable<Match["peer"]>["kind"], id = "*") =>
  binding(accountId, { peer: { kind, id } });
function resolve(matches: Match[], scope: Scope = {}, channelId = "qa-channel") {
  return resolveFirstBoundAccountId({
    agentId: "bot-alpha",
    channelId,
    ...scope,
    cfg: { bindings: matches.map((match) => ({ type: "route", agentId: "bot-alpha", match })) },
  });
}

it("preserves first-match binding order for peerless callers", () => {
  expect(resolve([peer("wildcard", "channel"), binding("default")])).toBe("wildcard");
});

it.each([
  ["channel", "room"],
  ["direct", "dm"],
  ["group", "room"],
  [undefined, "default"],
] as const)("selects wildcard bindings compatible with caller kind %s", (peerKind, expected) => {
  const matches = [peer("dm", "direct"), peer("room", "channel"), binding("default")];
  expect(resolve(matches, { peerId: "room-or-user", peerKind })).toBe(expected);
});

it("accepts group bindings for channel peers", () => {
  expect(resolve([peer("group", "group")], { peerId: "room", peerKind: "channel" })).toBe("group");
});

it("matches exact canonical peer aliases before falling back to wildcard bindings", () => {
  expect(
    resolve(
      [peer("wildcard", "channel"), peer("conversation", "channel", "channel:conversation-a")],
      {
        peerId: "conversation-a",
        exactPeerIdAliases: ["channel:conversation-a"],
        peerKind: "channel",
      },
    ),
  ).toBe("conversation");
});

it("skips peer-specific bindings whose kind does not match the caller's peerKind", () => {
  expect(
    resolve([peer("wrong-kind", "direct", "!room:example.org"), binding("default")], {
      peerId: "!room:example.org",
      peerKind: "channel",
    }),
  ).toBe("default");
});

it("skips scoped bindings when the caller has no matching group space", () => {
  expect(
    resolve([binding("other-guild", { guildId: "guild-other" }), binding("default")], {
      groupSpace: "guild-current",
    }),
  ).toBe("default");
});

it("matches scoped guild and team bindings against caller group space", () => {
  const matches = [
    binding("guild", { channel: "discord", guildId: "guild-current" }),
    binding("team", { channel: "slack", teamId: "team-current" }),
  ];
  expect(resolve(matches, { groupSpace: "guild-current" }, "discord")).toBe("guild");
  expect(resolve(matches, { groupSpace: "team-current" }, "slack")).toBe("team");
});

it("requires caller roles before selecting role-scoped bindings", () => {
  const matches = [
    binding("admin", { guildId: "guild-current", roles: ["admin"] }),
    binding("default"),
  ];
  const scope = { groupSpace: "guild-current" };
  expect(resolve(matches, { ...scope, memberRoleIds: ["member"] })).toBe("default");
  expect(resolve(matches, { ...scope, memberRoleIds: ["admin"] })).toBe("admin");
});
