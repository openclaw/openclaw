import { describe, expect, it } from "vitest";
import { resolveLastChannelRaw, resolveLastToRaw } from "./session-delivery.js";

describe("session delivery bound channel routing", () => {
  it("delivers to bound external channel when persistedLastTo is set", () => {
    // Session has deliveryContext bound to Telegram channel
    const sessionKey = "agent:main:telegram:default:channel:C123456";

    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "INTERNAL_MESSAGE_CHANNEL",
        persistedLastChannel: "telegram",
        sessionKey,
      }),
    ).toBe("telegram");

    expect(
      resolveLastToRaw({
        originatingChannelRaw: "INTERNAL_MESSAGE_CHANNEL",
        originatingToRaw: "session:inter-session-123",
        persistedLastChannel: "telegram",
        persistedLastTo: "C123456",
        sessionKey,
      }),
    ).toBe("C123456");
  });

  it("falls back to originatingToRaw when persistedLastTo is not set", () => {
    // Session bound to external channel but lastTo not yet persisted
    const sessionKey = "agent:main:telegram:default:channel:C123456";

    expect(
      resolveLastToRaw({
        originatingChannelRaw: "INTERNAL_MESSAGE_CHANNEL",
        originatingToRaw: "session:inter-session-123",
        persistedLastChannel: "telegram",
        persistedLastTo: undefined,
        sessionKey,
      }),
    ).toBe("session:inter-session-123");
  });

  it("does not drop delivery when persistedLastTo is falsy", () => {
    // Regression test: ensure we don't silently drop messages
    const sessionKey = "agent:main:telegram:default:channel:C123456";

    const result = resolveLastToRaw({
      originatingChannelRaw: "INTERNAL_MESSAGE_CHANNEL",
      originatingToRaw: "session:inter-session-123",
      persistedLastChannel: "telegram",
      persistedLastTo: undefined,
      sessionKey,
    });

    // Should NOT return undefined (which would drop the message)
    expect(result).not.toBeUndefined();
    expect(result).toBe("session:inter-session-123");
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
