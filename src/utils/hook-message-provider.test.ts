import { describe, expect, it } from "vitest";
import {
  inferHookMessageProviderFromSessionKey,
  resolveHookMessageProvider,
} from "./hook-message-provider.js";

describe("hook message provider", () => {
  it("preserves explicit synthetic provider identities", () => {
    expect(
      resolveHookMessageProvider({
        sessionKey: "agent:main:telegram:direct:123",
        provider: "internal",
      }),
    ).toBe("internal");
  });

  it("normalizes explicit deliverable providers", () => {
    expect(
      resolveHookMessageProvider({
        sessionKey: "agent:main:main",
        provider: "Telegram",
      }),
    ).toBe("telegram");
  });

  it("infers providers only from agent-scoped deliverable channel keys", () => {
    expect(inferHookMessageProviderFromSessionKey("agent:main:telegram:direct:123")).toBe(
      "telegram",
    );
    expect(inferHookMessageProviderFromSessionKey("telegram:direct:123")).toBeUndefined();
    expect(inferHookMessageProviderFromSessionKey("agent:main:direct:peer_123")).toBeUndefined();
    expect(inferHookMessageProviderFromSessionKey("agent:main:cron:job")).toBeUndefined();
    expect(inferHookMessageProviderFromSessionKey("agent:main:hook:webhook:42")).toBeUndefined();
  });
});
