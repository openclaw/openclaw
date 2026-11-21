import { describe, expect, it } from "vitest";
import {
  resolveChannelSenderAvatarUrl,
  type ChannelSenderAvatarSource,
} from "./channel-sender-avatar.ts";
import type { SenderIdentity } from "./sender-label.ts";

const sender: SenderIdentity = {
  name: "Riley Adams",
  identity: {
    type: "observation",
    pluginId: "telegram",
    accountId: "sample-bot",
    id: "1000000001",
    senderKind: "human",
  },
};
const session: ChannelSenderAvatarSource = {
  key: "agent:main:main",
  channelAvatarUrl: "/__openclaw__/channel-avatar/agent%3Amain%3Amain?v=portrait-1",
  origin: {
    provider: "telegram",
    accountId: "sample-bot",
    chatType: "direct",
    from: "telegram:1000000001",
  },
};

describe("observed sender channel portraits", () => {
  it("binds a native DM photo to its channel, account, sender and image revision without rewriting identity", () => {
    const before = structuredClone(sender);
    const url = new URL(resolveChannelSenderAvatarUrl(sender, session)!, "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      v: "portrait-1",
      provider: "telegram",
      account: "sample-bot",
      sender: "1000000001",
    });
    expect(sender).toEqual(before);
  });

  it.each([
    { provider: "slack" },
    { accountId: "another-bot" },
    { from: "telegram:1000000002" },
    { chatType: "group" },
    { from: undefined },
  ] satisfies Partial<NonNullable<ChannelSenderAvatarSource["origin"]>>[])(
    "does not borrow another source's photo: %j",
    (origin) => {
      expect(
        resolveChannelSenderAvatarUrl(sender, {
          ...session,
          origin: { ...session.origin, ...origin },
        }),
      ).toBeNull();
    },
  );

  it.each([
    "https://example.test/photo.png",
    "//example.test/photo.png",
    "/api/users/gateway-owner/avatar",
    "/__openclaw__/channel-avatar/another-session?v=portrait-1",
    "/__openclaw__/channel-avatar/agent%3Amain%3Amain",
  ])("rejects a noncanonical or unbound route: %s", (channelAvatarUrl) => {
    expect(resolveChannelSenderAvatarUrl(sender, { ...session, channelAvatarUrl })).toBeNull();
  });

  it("never substitutes a channel photo for a profile or unattributed sender", () => {
    expect(
      resolveChannelSenderAvatarUrl(
        { name: sender.name, identity: { type: "profile", id: "gateway-owner" } },
        session,
      ),
    ).toBeNull();
    expect(
      resolveChannelSenderAvatarUrl({ name: sender.name, id: "1000000001" }, session),
    ).toBeNull();
    expect(resolveChannelSenderAvatarUrl(sender, undefined)).toBeNull();
  });
});
