import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveGroupSessionKey } from "./group.js";

describe("resolveGroupSessionKey", () => {
  it("uses OriginatingTo channel id when Discord channel chats provide sender-shaped From", () => {
    const ctx = {
      Provider: "discord",
      ChatType: "channel",
      From: "discord:657229412030480397",
      OriginatingTo: "channel:1476858065914695741",
      To: "slash:657229412030480397",
    } as MsgContext;

    expect(resolveGroupSessionKey(ctx)).toEqual({
      key: "discord:channel:1476858065914695741",
      channel: "discord",
      id: "1476858065914695741",
      chatType: "channel",
    });
  });

  it("falls back to To when OriginatingTo is absent", () => {
    const ctx = {
      Provider: "discord",
      ChatType: "channel",
      From: "discord:657229412030480397",
      To: "discord:channel:1476858065914695741",
    } as MsgContext;

    expect(resolveGroupSessionKey(ctx)).toEqual({
      key: "discord:channel:1476858065914695741",
      channel: "discord",
      id: "1476858065914695741",
      chatType: "channel",
    });
  });

  it("keeps legacy behavior when no Discord channel hint is available", () => {
    const ctx = {
      Provider: "discord",
      ChatType: "channel",
      From: "discord:657229412030480397",
    } as MsgContext;

    expect(resolveGroupSessionKey(ctx)).toEqual({
      key: "discord:channel:657229412030480397",
      channel: "discord",
      id: "657229412030480397",
      chatType: "channel",
    });
  });
});
