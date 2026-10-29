// Session key tests cover session key generation and normalization.
import { describe, expect, it } from "vitest";
import { resolveSessionKey } from "./session-key.js";
import { installDiscordSessionKeyNormalizerFixture, makeCtx } from "./session-key.test-helpers.js";

installDiscordSessionKeyNormalizerFixture();

describe("resolveSessionKey", () => {
  it("uses an explicit agent id for canonical direct-chat keys", () => {
    const ctx = makeCtx({
      From: "+15551234567",
    });

    expect(resolveSessionKey("per-sender", ctx, "main", "ops")).toBe("agent:ops:main");
  });

  it("uses an explicit agent id for group keys", () => {
    const ctx = makeCtx({
      From: "C123",
      ChatType: "channel",
      Provider: "slack",
    });

    expect(resolveSessionKey("per-sender", ctx, "main", "ops")).toBe(
      "agent:ops:slack:channel:c123",
    );
  });

  it("dispatches explicit session keys through the provider normalizer", () => {
    const ctx = makeCtx({
      SessionKey: "agent:fina:discord:channel:123456",
      ChatType: "direct",
      From: "discord:123456",
      SenderId: "123456",
    });
    expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:direct:123456");
  });
});
