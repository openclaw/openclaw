import { describe, expect, it } from "vitest";
import type { SessionOrigin } from "../config/sessions/types.js";
import { channelAvatarRevision, matchesChannelAvatarSender } from "./channel-avatar-reference.js";

const origin: SessionOrigin = {
  provider: "telegram",
  accountId: "sample-bot",
  from: "telegram:1000000001",
  chatType: "direct",
  avatar: "media:inbound:photo-one",
};
const query = () =>
  new URLSearchParams({
    sender: "1000000001",
    provider: "telegram",
    account: "sample-bot",
    v: channelAvatarRevision(origin.avatar!),
  });

describe("channel avatar sender binding", () => {
  it("accepts only the requested native peer and current media revision", () => {
    expect(matchesChannelAvatarSender(query(), origin)).toBe(true);
  });
  it.each([
    { provider: "slack" },
    { accountId: "another-bot" },
    { from: "telegram:1000000002" },
    { chatType: "group" },
    { avatar: "media:inbound:photo-two" },
    { avatar: undefined },
  ] satisfies Partial<SessionOrigin>[])(
    "rejects a stale source or image snapshot: %j",
    (changed) => {
      expect(matchesChannelAvatarSender(query(), { ...origin, ...changed })).toBe(false);
    },
  );
  it("rejects partial sender claims and missing origins", () => {
    expect(matchesChannelAvatarSender(new URLSearchParams({ sender: "1000000001" }), origin)).toBe(
      false,
    );
    expect(matchesChannelAvatarSender(query(), undefined)).toBe(false);
  });
  it("retains the existing conversation-icon route contract", () => {
    expect(matchesChannelAvatarSender(new URLSearchParams(), origin)).toBe(true);
  });
});
