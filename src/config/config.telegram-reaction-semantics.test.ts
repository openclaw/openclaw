import { describe, expect, it } from "vitest";
import { TelegramConfigSchema } from "./zod-schema.providers-core.js";

describe("telegram reaction semantics schema", () => {
  it("accepts raw emoji and custom emoji semantic mappings", () => {
    const res = TelegramConfigSchema.safeParse({
      reactionSemantics: {
        "👍": "acknowledged",
        "custom_emoji:1234567890123456789": {
          meaning: "execute-approved-plan",
          instruction:
            "Treat this as operator approval to execute the previously proposed action set if policy allows.",
          action: "wake",
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.reactionSemantics).toEqual({
      "👍": "acknowledged",
      "custom_emoji:1234567890123456789": {
        meaning: "execute-approved-plan",
        instruction:
          "Treat this as operator approval to execute the previously proposed action set if policy allows.",
        action: "wake",
      },
    });
  });

  it("rejects invalid reaction semantic actions", () => {
    const res = TelegramConfigSchema.safeParse({
      reactionSemantics: {
        "emoji:✅": {
          meaning: "completed",
          action: "execute-now",
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects shorthand and explicit keys that collide after normalization", () => {
    const res = TelegramConfigSchema.safeParse({
      reactionSemantics: {
        "👍": "acknowledged",
        "emoji:👍": {
          meaning: "duplicate",
          action: "queue",
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(JSON.stringify(res.error.format())).toContain("duplicates");
    expect(JSON.stringify(res.error.format())).toContain("emoji:👍");
  });

  it.each([
    "customemoji:123",
    "emoji:",
    "emoji:thumbsup",
    "custom_emoji:   ",
    "custom_emoji:abc",
    "thumbsup",
  ])("rejects invalid reaction semantics key %s", (invalidKey) => {
    const res = TelegramConfigSchema.safeParse({
      reactionSemantics: {
        [invalidKey]: "acknowledged",
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(JSON.stringify(res.error.format())).toContain("invalid");
    expect(JSON.stringify(res.error.format())).toContain(invalidKey.trim());
  });
});
