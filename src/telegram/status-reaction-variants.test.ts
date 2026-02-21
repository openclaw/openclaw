import { describe, expect, it } from "vitest";
import { DEFAULT_EMOJIS } from "../channels/status-reactions.js";
import {
  buildTelegramStatusReactionVariants,
  isTelegramSupportedReactionEmoji,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis,
} from "./status-reaction-variants.js";

describe("resolveTelegramStatusReactionEmojis", () => {
  it("falls back to Telegram-safe defaults for empty overrides", () => {
    const result = resolveTelegramStatusReactionEmojis({
      initialEmoji: "👀",
      overrides: {
        thinking: "   ",
        done: "\n",
      },
    });

    expect(result.queued).toBe("👀");
    expect(result.thinking).toBe(DEFAULT_EMOJIS.thinking);
    expect(result.done).toBe(DEFAULT_EMOJIS.done);
  });

  it("preserves explicit non-empty overrides", () => {
    const result = resolveTelegramStatusReactionEmojis({
      initialEmoji: "👀",
      overrides: {
        thinking: "🫡",
        done: "🎉",
      },
    });

    expect(result.thinking).toBe("🫡");
    expect(result.done).toBe("🎉");
  });
});

describe("buildTelegramStatusReactionVariants", () => {
  it("puts requested emoji first and appends Telegram fallbacks", () => {
    const variants = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "🛠️",
    });

    expect(variants.get("🛠️")).toEqual(["🛠️", "👨‍💻", "🔥", "⚡"]);
  });
});

describe("isTelegramSupportedReactionEmoji", () => {
  it("accepts Telegram-supported reaction emojis", () => {
    expect(isTelegramSupportedReactionEmoji("👀")).toBe(true);
    expect(isTelegramSupportedReactionEmoji("👨‍💻")).toBe(true);
  });

  it("rejects unsupported emojis", () => {
    expect(isTelegramSupportedReactionEmoji("🫠")).toBe(false);
  });
});

describe("resolveTelegramReactionVariant", () => {
  it("returns requested emoji when already Telegram-supported", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "👨‍💻",
    });

    const result = resolveTelegramReactionVariant({
      requestedEmoji: "👨‍💻",
      variantsByRequestedEmoji: variantsByEmoji,
    });

    expect(result).toBe("👨‍💻");
  });

  it("returns first Telegram-supported fallback for unsupported requested emoji", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "🛠️",
    });

    const result = resolveTelegramReactionVariant({
      requestedEmoji: "🛠️",
      variantsByRequestedEmoji: variantsByEmoji,
    });

    expect(result).toBe("👨‍💻");
  });

  it("uses generic Telegram fallbacks for unknown emojis", () => {
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "🫠",
      variantsByRequestedEmoji: new Map(),
    });

    expect(result).toBe("👍");
  });

  it("returns undefined for empty requested emoji", () => {
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "   ",
      variantsByRequestedEmoji: new Map(),
    });

    expect(result).toBeUndefined();
  });
});
