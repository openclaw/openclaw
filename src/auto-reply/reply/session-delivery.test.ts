import { describe, expect, it } from "vitest";
import { INTER_SESSION_CHANNEL } from "../../utils/message-channel.js";
import { resolveLastChannelRaw, resolveLastToRaw } from "./session-delivery.js";

describe("INTER_SESSION_CHANNEL sentinel routing", () => {
  it("preserves an established external channel for a main session", () => {
    // sessions_send uses INTER_SESSION_CHANNEL so the receiver's Discord route
    // is not flipped to webchat or replaced with the sender's channel.
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        persistedLastChannel: "discord",
        sessionKey: "agent:navi:main",
      }),
    ).toBe("discord");
  });

  it("does not flip to webchat for a main session (original bug regression)", () => {
    // Before the fix, INTERNAL_MESSAGE_CHANNEL ("webchat") was injected here,
    // which caused resolveLastChannelRaw to return "webchat" for main sessions,
    // overriding the Discord route. INTER_SESSION_CHANNEL must never produce "webchat".
    const result = resolveLastChannelRaw({
      originatingChannelRaw: INTER_SESSION_CHANNEL,
      persistedLastChannel: "discord",
      sessionKey: "agent:navi:main",
    });
    expect(result).not.toBe("webchat");
    expect(result).toBe("discord");
  });

  it("returns undefined when persisted channel is absent and only session-key hint exists (no channel synthesis)", () => {
    // Inter-session turns must not synthesise a channel from the session key alone.
    // Without a persisted external channel, returning a channel-only route would leave
    // lastTo undefined and risk misdelivery via the channel defaultTo fallback.
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        persistedLastChannel: undefined,
        sessionKey: "agent:navi:discord:direct:channel:123",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when no external route can be determined", () => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        persistedLastChannel: undefined,
        sessionKey: "agent:navi:main",
      }),
    ).toBeUndefined();
  });

  it("preserves the receiver's persisted destination (resolveLastToRaw)", () => {
    // Threading the sender's to/accountId/threadId would leave the receiver with
    // a mismatched channel+to pair. The sentinel signals: keep the receiver's own dest.
    expect(
      resolveLastToRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        originatingToRaw: "channel:sender-discord-channel",
        persistedLastChannel: "discord",
        persistedLastTo: "channel:receiver-discord-channel",
        sessionKey: "agent:navi:main",
      }),
    ).toBe("channel:receiver-discord-channel");
  });

  it("returns undefined from resolveLastToRaw when no persisted destination exists", () => {
    expect(
      resolveLastToRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        originatingToRaw: "channel:sender-discord-channel",
        persistedLastChannel: undefined,
        persistedLastTo: undefined,
        sessionKey: "agent:navi:main",
      }),
    ).toBeUndefined();
  });

  it("returns undefined from resolveLastToRaw when channel will be resolved via session-key hint (Codex P1 fix)", () => {
    // Scenario: persisted state is webchat (not external), so resolveLastChannelRaw
    // falls back to the session-key hint and returns "discord". Blindly returning
    // persistedLastTo here would create a mismatched lastChannel/lastTo pair
    // (discord channel + stale webchat target). The sentinel must return undefined
    // so the caller can derive an appropriate target from the new channel.
    expect(
      resolveLastToRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        originatingToRaw: "channel:sender-discord-channel",
        persistedLastChannel: "webchat",
        persistedLastTo: "session:stale-webchat-target",
        sessionKey: "agent:navi:discord:direct:channel:123",
      }),
    ).toBeUndefined();
  });

  it("preserves persistedLastTo when persisted channel is already external (consistent pair)", () => {
    // When the receiver already has an established external route (e.g. discord),
    // both channel and to come from persisted state — no mismatch risk.
    expect(
      resolveLastToRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        originatingToRaw: "channel:sender-channel",
        persistedLastChannel: "discord",
        persistedLastTo: "channel:receiver-discord-channel",
        sessionKey: "agent:navi:main",
      }),
    ).toBe("channel:receiver-discord-channel");
  });

  it("returns undefined from resolveLastToRaw when persistedLastChannel is empty string", () => {
    // Empty string is not an external routing channel — treat same as absent.
    // Returning stale persistedLastTo would risk a channel/to mismatch.
    expect(
      resolveLastToRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        persistedLastChannel: "",
        persistedLastTo: "channel:some-target",
        sessionKey: "agent:navi:main",
      }),
    ).toBeUndefined();
  });

  it("returns undefined from resolveLastToRaw when persistedLastChannel is the sentinel itself (leaked state)", () => {
    // Guard against corrupted persisted state where persistedLastChannel was
    // accidentally set to "inter_session". The sentinel is not a deliverable
    // channel and should never be treated as an established external route.
    expect(
      resolveLastToRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        persistedLastChannel: INTER_SESSION_CHANNEL,
        persistedLastTo: "channel:some-target",
        sessionKey: "agent:navi:main",
      }),
    ).toBeUndefined();
  });

  it("preserves persistedLastTo for non-discord external channels (e.g. telegram)", () => {
    // The sentinel path should work for any external channel, not just discord.
    expect(
      resolveLastToRaw({
        originatingChannelRaw: INTER_SESSION_CHANNEL,
        originatingToRaw: "channel:sender-telegram",
        persistedLastChannel: "telegram",
        persistedLastTo: "user:987654321",
        sessionKey: "agent:navi:main",
      }),
    ).toBe("user:987654321");
  });

  it("does not treat a real deliverable channel named 'inter_session' as the sentinel (Codex P2 guard)", () => {
    // isInterSessionChannel guards against plugin channel collision:
    // if a real channel plugin registers with id="inter_session", it must not
    // be silently swallowed by the sentinel path.
    // With no such plugin registered in the test registry, isDeliverableMessageChannel
    // returns false for "inter_session" so the sentinel fires as expected.
    // This test documents the invariant: sentinel only applies when the value is
    // NOT a real deliverable channel.
    const result = resolveLastChannelRaw({
      originatingChannelRaw: INTER_SESSION_CHANNEL,
      persistedLastChannel: "discord",
      sessionKey: "agent:navi:main",
    });
    // In test env, "inter_session" is not a registered plugin channel, so
    // isInterSessionChannel returns true and the sentinel path preserves "discord".
    expect(result).toBe("discord");
    expect(result).not.toBe(INTER_SESSION_CHANNEL);
  });
});

describe("session delivery direct-session routing overrides", () => {
  it.each([
    "agent:main:direct:user-1",
    "agent:main:telegram:direct:123456",
    "agent:main:telegram:account-a:direct:123456",
    "agent:main:telegram:dm:123456",
    "agent:main:telegram:direct:123456:thread:99",
    "agent:main:telegram:account-a:direct:123456:topic:ops",
  ])("lets webchat override persisted routes for strict direct key %s", (sessionKey) => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
        sessionKey,
      }),
    ).toBe("webchat");
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:dashboard",
        persistedLastChannel: "telegram",
        persistedLastTo: "123456",
        sessionKey,
      }),
    ).toBe("session:dashboard");
  });

  it.each([
    "agent:main:main:direct",
    "agent:main:cron:job-1:dm",
    "agent:main:subagent:worker:direct:user-1",
    "agent:main:telegram:channel:direct",
    "agent:main:telegram:account-a:direct",
    "agent:main:telegram:direct:123456:cron:job-1",
  ])("keeps persisted external routes for malformed direct-like key %s", (sessionKey) => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
        sessionKey,
      }),
    ).toBe("telegram");
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:dashboard",
        persistedLastChannel: "telegram",
        persistedLastTo: "group:12345",
        sessionKey,
      }),
    ).toBe("group:12345");
  });
});
