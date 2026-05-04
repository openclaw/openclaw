import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";

type ReactionResolution = ReturnType<typeof resolveWhatsAppReactionLevel>;

describe("resolveWhatsAppReactionLevel", () => {
  it("defaults to minimal when reactionLevel is not set", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: {} },
    };
    const result = resolveWhatsAppReactionLevel({ cfg });
    expect(result).toStrictEqual({
      level: "minimal",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "minimal",
    } satisfies ReactionResolution);
  });

  it("returns extensive when configured", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "extensive" } },
    };
    const result = resolveWhatsAppReactionLevel({ cfg });
    expect(result).toStrictEqual({
      level: "extensive",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "extensive",
    } satisfies ReactionResolution);
  });

  it("returns off when configured", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "off" } },
    };
    const result = resolveWhatsAppReactionLevel({ cfg });
    expect(result).toStrictEqual({
      level: "off",
      ackEnabled: false,
      agentReactionsEnabled: false,
    } satisfies ReactionResolution);
  });

  it("returns ack when configured", () => {
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { reactionLevel: "ack" } },
    };
    const result = resolveWhatsAppReactionLevel({ cfg });
    expect(result).toStrictEqual({
      level: "ack",
      ackEnabled: true,
      agentReactionsEnabled: false,
    } satisfies ReactionResolution);
  });

  it("account-level reactionLevel overrides channel-level", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          reactionLevel: "minimal",
          accounts: {
            personal: { reactionLevel: "extensive" },
          },
        },
      },
    };
    const result = resolveWhatsAppReactionLevel({ cfg, accountId: "personal" });
    expect(result.level).toBe("extensive");
    expect(result.agentReactionGuidance).toBe("extensive");
  });

  it("falls back to channel-level when account has no override", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          reactionLevel: "extensive",
          accounts: {
            personal: {},
          },
        },
      },
    };
    const result = resolveWhatsAppReactionLevel({ cfg, accountId: "personal" });
    expect(result.level).toBe("extensive");
  });

  it("handles missing whatsapp config gracefully", () => {
    const cfg: OpenClawConfig = {};
    const result = resolveWhatsAppReactionLevel({ cfg });
    expect(result.level).toBe("minimal");
    expect(result.agentReactionsEnabled).toBe(true);
  });
});
