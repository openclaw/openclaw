import { describe, expect, it, vi } from "vitest";

vi.mock("../../channels/plugins/index.js", () => ({
  normalizeChannelId: (id: string) => id,
  getChannelPlugin: (id: string) => {
    if (id === "custom") {
      return {
        messaging: {
          normalizeTarget: (raw: string) => raw.trim().toUpperCase(),
        },
      };
    }
    // Signal, Telegram, etc. — no custom normalizeTarget
    return {};
  },
}));

import { normalizeChannelTargetInput, normalizeTargetForProvider } from "./target-normalization.js";

describe("normalizeChannelTargetInput", () => {
  it("trims whitespace", () => {
    expect(normalizeChannelTargetInput("  foo  ")).toBe("foo");
  });
});

describe("normalizeTargetForProvider", () => {
  it("returns undefined for empty input", () => {
    expect(normalizeTargetForProvider("signal")).toBeUndefined();
    expect(normalizeTargetForProvider("signal", "")).toBeUndefined();
    expect(normalizeTargetForProvider("signal", "  ")).toBeUndefined();
  });

  it("preserves case for providers without custom normalizeTarget (#14263)", () => {
    // Signal base64 group IDs are case-sensitive
    const groupId = "j3LayAEQjuMh+DHdrwekeDLQbcqamJekGlLykxOedcc=";
    expect(normalizeTargetForProvider("signal", groupId)).toBe(groupId);
  });

  it("preserves case for Telegram targets", () => {
    expect(normalizeTargetForProvider("telegram", "ChatID_123")).toBe("ChatID_123");
  });

  it("trims whitespace in fallback path", () => {
    expect(normalizeTargetForProvider("signal", "  +1234567890  ")).toBe("+1234567890");
  });

  it("delegates to plugin normalizeTarget when available", () => {
    expect(normalizeTargetForProvider("custom", "hello")).toBe("HELLO");
  });
});
