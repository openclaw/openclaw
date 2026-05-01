import { describe, expect, it } from "vitest";
import { resolveSessionKey } from "./session-key.js";
import { installDiscordSessionKeyNormalizerFixture, makeCtx } from "./session-key.test-helpers.js";

installDiscordSessionKeyNormalizerFixture();

describe("resolveSessionKey default agent resolution", () => {
  it("uses DEFAULT_AGENT_ID when no agentId and no env override", () => {
    const ctx = makeCtx({ From: "+15550001111" });
    const key = resolveSessionKey("per-sender", ctx, undefined, undefined, {});
    expect(key).toBe("agent:main:main");
  });

  it("uses OPENCLAW_DEFAULT_AGENT_ID from env when no agentId provided", () => {
    const ctx = makeCtx({ From: "+15550001111" });
    const key = resolveSessionKey("per-sender", ctx, undefined, undefined, {
      OPENCLAW_DEFAULT_AGENT_ID: "ops",
    });
    expect(key).toBe("agent:ops:main");
  });

  it("explicit agentId param takes precedence over OPENCLAW_DEFAULT_AGENT_ID env", () => {
    const ctx = makeCtx({ From: "+15550001111" });
    const key = resolveSessionKey("per-sender", ctx, undefined, "beta", {
      OPENCLAW_DEFAULT_AGENT_ID: "ops",
    });
    expect(key).toBe("agent:beta:main");
  });
});

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

  describe("Discord DM session key normalization", () => {
    it("passes through correct discord:direct keys unchanged", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:direct:123456",
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:direct:123456");
    });

    it("migrates legacy discord:dm: keys to discord:direct:", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:dm:123456",
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:direct:123456");
    });

    it("fixes phantom discord:channel:USERID keys when sender matches", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:channel:123456",
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:direct:123456");
    });

    it("does not rewrite discord:channel: keys for non-direct chats", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:channel:123456",
        ChatType: "channel",
        From: "discord:channel:123456",
        SenderId: "789",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:channel:123456");
    });

    it("does not rewrite discord:channel: keys when sender does not match", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:channel:123456",
        ChatType: "direct",
        From: "discord:789",
        SenderId: "789",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:channel:123456");
    });

    it("handles keys without an agent prefix", () => {
      const ctx = makeCtx({
        SessionKey: "discord:channel:123456",
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("discord:direct:123456");
    });
  });
});
