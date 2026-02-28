import { describe, expect, it } from "vitest";
import { DEFAULT_EMOJIS } from "../channels/status-reactions.js";
import {
  buildTelegramStatusReactionVariants,
  extractTelegramAllowedEmojiReactions,
  isTelegramSupportedReactionEmoji,
  resolveTelegramAllowedEmojiReactions,
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

describe("extractTelegramAllowedEmojiReactions", () => {
  it("returns undefined when chat does not include available_reactions", () => {
    const result = extractTelegramAllowedEmojiReactions({ id: 1 });
    expect(result).toBeUndefined();
  });

  it("returns null when available_reactions is omitted/null", () => {
    const result = extractTelegramAllowedEmojiReactions({ available_reactions: null });
    expect(result).toBeNull();
  });

  it("extracts emoji reactions only", () => {
    const result = extractTelegramAllowedEmojiReactions({
      available_reactions: [
        { type: "emoji", emoji: "👍" },
        { type: "custom_emoji", custom_emoji_id: "abc" },
        { type: "emoji", emoji: "🔥" },
      ],
    });
    expect(result ? Array.from(result).toSorted() : null).toEqual(["👍", "🔥"]);
  });
});

describe("resolveTelegramAllowedEmojiReactions", () => {
  it("uses getChat lookup when message chat does not include available_reactions", async () => {
    const getChat = async () => ({
      available_reactions: [{ type: "emoji", emoji: "👍" }],
    });

    const result = await resolveTelegramAllowedEmojiReactions({
      chat: { id: 1 },
      chatId: 1,
      getChat,
    });

    expect(result ? Array.from(result) : null).toEqual(["👍"]);
  });

  it("falls back to unrestricted reactions when getChat lookup fails", async () => {
    const getChat = async () => {
      throw new Error("lookup failed");
    };

    const result = await resolveTelegramAllowedEmojiReactions({
      chat: { id: 1 },
      chatId: 1,
      getChat,
    });

    expect(result).toBeNull();
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

  it("respects chat allowed reactions", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "👨‍💻",
    });

    const result = resolveTelegramReactionVariant({
      requestedEmoji: "👨‍💻",
      variantsByRequestedEmoji: variantsByEmoji,
      allowedEmojiReactions: new Set(["👍"]),
    });

    expect(result).toBe("👍");
  });

  it("returns undefined when no candidate is chat-allowed", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "👨‍💻",
    });

    const result = resolveTelegramReactionVariant({
      requestedEmoji: "👨‍💻",
      variantsByRequestedEmoji: variantsByEmoji,
      allowedEmojiReactions: new Set(["🎉"]),
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined for empty requested emoji", () => {
    const result = resolveTelegramReactionVariant({
      requestedEmoji: "   ",
      variantsByRequestedEmoji: new Map(),
    });

    expect(result).toBeUndefined();
  });
});
