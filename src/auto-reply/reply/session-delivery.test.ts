import { describe, expect, it } from "vitest";
import { resolveLastChannelRaw, resolveLastToRaw } from "./session-delivery.js";

describe("inter-session lastRoute preservation (fixes #54441)", () => {
  it("inter-session message does NOT overwrite established Discord lastChannel", () => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "discord",
        isInterSession: true,
      }),
    ).toBe("discord");
  });

  it("inter-session message does NOT overwrite established Telegram lastChannel", () => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
        isInterSession: true,
      }),
    ).toBe("telegram");
  });

  it("inter-session message does NOT overwrite established external lastTo", () => {
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:somekey",
        toRaw: "session:somekey",
        persistedLastTo: "channel:1234567890",
        persistedLastChannel: "discord",
        isInterSession: true,
      }),
    ).toBe("channel:1234567890");
  });

  it("regular Discord user message DOES update lastChannel normally", () => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "discord",
        persistedLastChannel: "discord",
        isInterSession: false,
      }),
    ).toBe("discord");
  });

  it("inter-session on a NEW session (no persisted external route) may set webchat", () => {
    // When there is no established external route, inter-session should not
    // forcefully block the update — the session has no external route to protect.
    const result = resolveLastChannelRaw({
      originatingChannelRaw: "webchat",
      persistedLastChannel: undefined,
      chatType: "direct",
      isInterSession: true,
    });
    // No external route existed — falls through to normal resolution (webchat or undefined).
    expect(["webchat", undefined]).toContain(result);
  });

  it("inter-session on session with no persisted lastTo preserves session route", () => {
    const result = resolveLastToRaw({
      originatingChannelRaw: "webchat",
      originatingToRaw: "session:somekey",
      toRaw: "session:somekey",
      persistedLastTo: undefined,
      persistedLastChannel: undefined,
      chatType: "direct",
      isInterSession: true,
    });
    // No external route — falls through to normal resolution
    expect(["session:somekey", undefined]).toContain(result);
  });
});

describe("session delivery direct-session routing overrides", () => {
  it("preserves persisted external route when webchat accesses a typed direct session", () => {
    // Webchat/dashboard viewing an external-channel session must not overwrite
    // the delivery route — subagents must still deliver to the original channel.
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
        chatType: "direct",
      }),
    ).toBe("telegram");
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:dashboard",
        persistedLastChannel: "telegram",
        persistedLastTo: "123456",
        chatType: "direct",
      }),
    ).toBe("123456");
  });

  it("keeps persisted external routes even without typed direct metadata", () => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
      }),
    ).toBe("telegram");
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:dashboard",
        persistedLastChannel: "telegram",
        persistedLastTo: "group:12345",
      }),
    ).toBe("group:12345");
  });
});
