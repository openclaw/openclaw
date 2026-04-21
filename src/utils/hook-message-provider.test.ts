import { describe, expect, it } from "vitest";
import {
  inferHookMessageProviderFromSessionKey,
  resolveHookMessageProvider,
} from "./hook-message-provider.js";

describe("inferHookMessageProviderFromSessionKey", () => {
  it("infers deliverable providers for channel-scoped direct keys", () => {
    expect(
      inferHookMessageProviderFromSessionKey("agent:main:telegram:default:direct:ou_test"),
    ).toBe("telegram");
  });

  it("infers internal webchat providers for channel-scoped webchat keys", () => {
    expect(inferHookMessageProviderFromSessionKey("agent:main:webchat:dm:user-123")).toBe(
      "webchat",
    );
  });

  it("does not infer providers from custom keys that only start with a channel id", () => {
    expect(inferHookMessageProviderFromSessionKey("agent:main:telegram:notes")).toBeUndefined();
  });

  it("does not infer providers from non-channel direct session keys", () => {
    expect(inferHookMessageProviderFromSessionKey("agent:main:direct:peer_123")).toBeUndefined();
  });
});

describe("resolveHookMessageProvider", () => {
  it("preserves explicit internal providers for main-session hooks", () => {
    expect(
      resolveHookMessageProvider({
        sessionKey: "agent:main:main",
        provider: "webchat",
      }),
    ).toBe("webchat");
  });

  it("normalizes explicit deliverable providers before returning them", () => {
    expect(
      resolveHookMessageProvider({
        sessionKey: "agent:main:telegram:direct:123",
        provider: "Telegram",
      }),
    ).toBe("telegram");
  });

  it("preserves explicit synthetic provider identities", () => {
    expect(
      resolveHookMessageProvider({
        sessionKey: "agent:main:telegram:direct:123",
        provider: "internal",
      }),
    ).toBe("internal");
  });

  it("falls back to channel-scoped session key inference when no provider is explicit", () => {
    expect(
      resolveHookMessageProvider({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    ).toBe("telegram");
  });

  it("does not infer from unscoped or non-channel session keys", () => {
    expect(inferHookMessageProviderFromSessionKey("telegram:direct:123")).toBeUndefined();
    expect(inferHookMessageProviderFromSessionKey("agent:main:direct:peer_123")).toBeUndefined();
    expect(inferHookMessageProviderFromSessionKey("agent:main:cron:job")).toBeUndefined();
    expect(inferHookMessageProviderFromSessionKey("agent:main:hook:webhook:42")).toBeUndefined();
  });
});
