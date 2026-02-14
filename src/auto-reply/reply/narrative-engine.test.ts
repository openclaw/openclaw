import { describe, expect, it } from "vitest";
import { type Agenda, matchVariant, type NarrativeVariant } from "./narrative-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function variant(overrides: Partial<NarrativeVariant> = {}): NarrativeVariant {
  return {
    field_pattern: "test",
    framing: "Test framing",
    tone: "neutral",
    talking_points: ["Point A", "Point B"],
    forbidden_words: ["bad", "evil"],
    ...overrides,
  };
}

function agenda(overrides: Partial<Agenda> = {}): Agenda {
  return {
    id: "test-agenda",
    topic: "Test Topic",
    description: "Test description",
    variants: [variant()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// matchVariant
// ---------------------------------------------------------------------------

describe("matchVariant", () => {
  it("returns null when no variants match", () => {
    const a = agenda({ variants: [variant({ field_pattern: "coffee" })] });
    expect(matchVariant(a, "telegram:-100", "Work Chat")).toBeNull();
  });

  it("matches by regex against sessionKey", () => {
    const a = agenda({ variants: [variant({ field_pattern: "思考者咖啡" })] });
    const result = matchVariant(a, "telegram:思考者咖啡群", undefined);
    expect(result).not.toBeNull();
    expect(result!.field_pattern).toBe("思考者咖啡");
  });

  it("matches by regex against chatName", () => {
    const a = agenda({ variants: [variant({ field_pattern: "咖啡" })] });
    const result = matchVariant(a, "telegram:-100", "思考者咖啡群");
    expect(result).not.toBeNull();
  });

  it("matches case-insensitively", () => {
    const a = agenda({ variants: [variant({ field_pattern: "BITA" })] });
    const result = matchVariant(a, "telegram:bita-group", undefined);
    expect(result).not.toBeNull();
  });

  it("supports regex OR patterns", () => {
    const a = agenda({ variants: [variant({ field_pattern: "幣塔|bita" })] });
    expect(matchVariant(a, "telegram:bita-cs", undefined)).not.toBeNull();
    expect(matchVariant(a, "telegram:幣塔客服", undefined)).not.toBeNull();
    expect(matchVariant(a, "telegram:random", undefined)).toBeNull();
  });

  it("falls back to includes when regex is invalid", () => {
    const a = agenda({ variants: [variant({ field_pattern: "[invalid(regex" })] });
    // The pattern itself contains "[invalid(regex" — not a valid regex
    // But if sessionKey contains the literal string, includes fallback works
    const result = matchVariant(a, "chat [invalid(regex stuff", undefined);
    expect(result).not.toBeNull();
  });

  it("returns first matching variant", () => {
    const a = agenda({
      variants: [
        variant({ field_pattern: "specific-chat", framing: "Specific" }),
        variant({ field_pattern: "chat", framing: "Generic" }),
      ],
    });
    const result = matchVariant(a, "specific-chat-123", undefined);
    expect(result!.framing).toBe("Specific");
  });

  it("matches with chatName as empty string", () => {
    const a = agenda({ variants: [variant({ field_pattern: "telegram" })] });
    const result = matchVariant(a, "telegram:-100", "");
    expect(result).not.toBeNull();
  });

  it("matches with chatName undefined", () => {
    const a = agenda({ variants: [variant({ field_pattern: "telegram" })] });
    const result = matchVariant(a, "telegram:-100");
    expect(result).not.toBeNull();
  });

  it("combines sessionKey and chatName for matching", () => {
    // Pattern only appears in chatName, not sessionKey
    const a = agenda({ variants: [variant({ field_pattern: "vip-room" })] });
    const result = matchVariant(a, "telegram:-100", "VIP-Room");
    expect(result).not.toBeNull();
  });

  it("returns null for empty variants array", () => {
    const a = agenda({ variants: [] });
    expect(matchVariant(a, "anything", "anything")).toBeNull();
  });
});
