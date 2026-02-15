import { describe, it, expect } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveSessionKey } from "./session-key.js";

function makeCtx(overrides: Partial<MsgContext>): MsgContext {
  return {
    Body: "",
    From: "",
    To: "",
    ...overrides,
  } as MsgContext;
}

describe("resolveSessionKey", () => {
  describe("Discord DM session key normalization", () => {
    it("should pass through correct discord:direct keys unchanged", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:direct:123456",
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:direct:123456");
    });

    it("should migrate legacy discord:dm: to discord:direct:", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:dm:123456",
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:direct:123456");
    });

    it("should fix phantom discord:channel:USERID to discord:direct:USERID when sender matches", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:channel:123456",
        ChatType: "direct",
        From: "discord:123456",
        SenderId: "123456",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:direct:123456");
    });

    it("should NOT fix discord:channel: when chatType is not direct", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:channel:123456",
        ChatType: "channel",
        From: "discord:channel:123456",
        SenderId: "789",
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:channel:123456");
    });

    it("should NOT fix discord:channel: when sender ID does not match", () => {
      const ctx = makeCtx({
        SessionKey: "agent:fina:discord:channel:123456",
        ChatType: "direct",
        From: "discord:789",
        SenderId: "789",
      });
      // sender 789 != channel id 123456, so don't rewrite
      expect(resolveSessionKey("per-sender", ctx)).toBe("agent:fina:discord:channel:123456");
    });

    it("should handle keys without agent: prefix", () => {
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
