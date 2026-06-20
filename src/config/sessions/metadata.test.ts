// Regression tests for session origin merging across a channel switch (#95325).
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import type { SessionEntry } from "./types.js";

function ctx(overrides: Partial<MsgContext>): MsgContext {
  return { ...overrides } as MsgContext;
}

function sessionWith(origin: SessionEntry["origin"]): SessionEntry {
  return { origin } as Partial<SessionEntry> as SessionEntry;
}

describe("deriveSessionMetaPatch origin channel switch (#95325)", () => {
  it("resets nativeChannelId/nativeDirectUserId/threadId when provider changes", () => {
    const existing = sessionWith({
      provider: "slack",
      surface: "slack",
      nativeChannelId: "Dslackdm",
      nativeDirectUserId: "Uslackuser",
      threadId: "slack-thread",
      accountId: "slack-account",
    });

    // Telegram DM carries no nativeChannelId/nativeDirectUserId/threadId.
    const next = ctx({
      Provider: "telegram",
      OriginatingChannel: "telegram",
      Surface: "telegram",
      From: "telegram-user",
      AccountId: "telegram-account",
    });

    const patch = deriveSessionMetaPatch({
      ctx: next,
      sessionKey: "test:key",
      existing,
    });

    expect(patch?.origin?.provider).toBe("telegram");
    expect(patch?.origin?.surface).toBe("telegram");
    expect(patch?.origin?.nativeChannelId).toBeUndefined();
    expect(patch?.origin?.nativeDirectUserId).toBeUndefined();
    expect(patch?.origin?.threadId).toBeUndefined();
  });

  it("preserves and updates nativeChannelId when the same channel keeps supplying it", () => {
    const existing = sessionWith({
      provider: "slack",
      nativeChannelId: "Dslackdm1",
    });

    const next = ctx({
      Provider: "slack",
      OriginatingChannel: "slack",
      NativeChannelId: "Dslackdm2",
    });

    const patch = deriveSessionMetaPatch({
      ctx: next,
      sessionKey: "test:key",
      existing,
    });

    expect(patch?.origin?.provider).toBe("slack");
    expect(patch?.origin?.nativeChannelId).toBe("Dslackdm2");
  });

  it("adopts the new channel's nativeChannelId when switching to a channel that supplies it", () => {
    const existing = sessionWith({
      provider: "telegram",
      nativeDirectUserId: "tg-user",
    });

    const next = ctx({
      Provider: "slack",
      OriginatingChannel: "slack",
      NativeChannelId: "Dnewslack",
    });

    const patch = deriveSessionMetaPatch({
      ctx: next,
      sessionKey: "test:key",
      existing,
    });

    expect(patch?.origin?.provider).toBe("slack");
    expect(patch?.origin?.nativeChannelId).toBe("Dnewslack");
    // Stale prior-channel nativeDirectUserId is reset by the channel switch.
    expect(patch?.origin?.nativeDirectUserId).toBeUndefined();
  });

  it("resets channel-specific fields when surface changes even if provider matches", () => {
    const existing = sessionWith({
      provider: "slack",
      surface: "slack",
      nativeChannelId: "Dslackdm",
    });

    const next = ctx({
      Provider: "slack",
      OriginatingChannel: "slack",
      Surface: "slack-im",
    });

    const patch = deriveSessionMetaPatch({
      ctx: next,
      sessionKey: "test:key",
      existing,
    });

    expect(patch?.origin?.surface).toBe("slack-im");
    expect(patch?.origin?.nativeChannelId).toBeUndefined();
  });
});
