import { describe, expect, it } from "vitest";
import { resolveLastChannelRaw, resolveLastToRaw } from "./session-delivery.js";

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

  it("keeps persisted webchat destination for synthetic heartbeat turns", () => {
    expect(
      resolveLastToRaw({
        providerRaw: "heartbeat",
        toRaw: "heartbeat",
        persistedLastChannel: "webchat",
        persistedLastTo: "openclaw-control-ui",
        sessionKey: "agent:main:main",
      }),
    ).toBe("openclaw-control-ui");
  });

  it("does not synthesize heartbeat as lastTo when no prior destination exists", () => {
    expect(
      resolveLastToRaw({
        providerRaw: "heartbeat",
        toRaw: "heartbeat",
        persistedLastChannel: "webchat",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });
});
