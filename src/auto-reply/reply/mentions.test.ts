import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  stripMentions,
  stripStructuralPrefixes,
} from "./mentions.js";

function mention(name: string, emoji?: string) {
  const cfg: OpenClawConfig = {
    agents: { entries: { agent: { identity: { name, emoji } } } },
  };
  const regexes = buildMentionRegexes(cfg, "agent");
  return {
    regexes,
    matches: (text: string) => matchesMentionPatterns(text, regexes),
    strip: (text: string) => stripMentions(text, {}, cfg, "agent"),
  };
}

describe("stripStructuralPrefixes", () => {
  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips sender prefix labels", () => {
    expect(stripStructuralPrefixes("John: hello")).toBe("hello");
  });

  it("preserves colon-delimited slash commands", () => {
    expect(stripStructuralPrefixes("/config:json")).toBe("/config:json");
    expect(stripStructuralPrefixes("/reset: soft")).toBe("/reset: soft");
  });

  it("strips slash-like display labels only after an envelope", () => {
    expect(stripStructuralPrefixes("[Telegram /reset id:123] /reset: hello")).toBe("hello");
  });

  it("does not treat a payload marker literal as structure", () => {
    const body = "please explain [Current message - respond to this] /status";
    expect(stripStructuralPrefixes(body)).toBe(body);
  });

  it.each([
    "[Chat messages since your last reply - for context]",
    "[Recent chat messages - for context]",
  ])("does not mine commands from ambiguous flat history: %s", (marker) => {
    const body = `${marker}\nOther: quoted [Current message - respond to this] /reset\n\n[Current message - respond to this]\nOwner: /status`;
    expect(stripStructuralPrefixes(body)).toBe(body);
  });

  it("preserves real line breaks in slash commands for downstream command parsing", () => {
    expect(stripStructuralPrefixes("/reset soft\nre-read persona files")).toBe(
      "/reset soft\nre-read persona files",
    );
    expect(stripStructuralPrefixes("/reset \\nsoft")).toBe("/reset soft");
  });
});

describe("derived mention matching and stripping", () => {
  it("matches single-character Han names without matching Unicode substrings", () => {
    const bot = mention("包");
    expect(bot.matches("@包 你好")).toBe(true);
    expect(bot.matches("包 你好")).toBe(true);
    expect(bot.matches("前包後")).toBe(false);
    expect(bot.matches("包みを開ける")).toBe(false);
    expect(bot.strip("@包 你好")).toBe("你好");
    expect(bot.strip("包みを開ける")).toBe("包みを開ける");
  });

  it("does not match a name inside a grapheme with combining marks", () => {
    expect(mention("क").matches("कि")).toBe(false);
    expect(mention("e").matches("e\u0301")).toBe(false);
  });

  it("keeps explicit configured patterns on their existing regex flags", () => {
    const regexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: [String.raw`\bopenclaw\b`] } },
    });
    expect(regexes[0]?.flags).toBe("i");
  });

  it("accepts interior decoration once, as whitespace, or omitted", () => {
    const bot = mention("Papillon🦋Bot");
    expect(bot.matches("Papillon🦋Bot help")).toBe(true);
    expect(bot.matches("papillon bot help")).toBe(true);
    expect(bot.matches("PapillonBot help")).toBe(true);
    expect(bot.matches("Papillon🦋🦋Bot /status")).toBe(false);
    expect(bot.strip("Papillon🦋🦋Bot /status")).toBe("Papillon🦋🦋Bot /status");
    expect(bot.strip("Papillon🦋Bot /status")).toBe("/status");
    expect(bot.matches("papillon...bot help")).toBe(false);
  });

  it("keeps non-emoji variation sequences literal inside names", () => {
    const bot = mention("foo$️bar");
    expect(bot.matches("foo$️bar status")).toBe(true);
    expect(bot.matches("foobar status")).toBe(false);
    expect(bot.matches("foo bar status")).toBe(false);
    expect(bot.strip("foobar /status")).toBe("foobar /status");
    expect(bot.strip("foo$️bar /status")).toBe("/status");
  });

  it("keeps punctuation required when it shares a gap with decoration", () => {
    const bot = mention("Clawd ・🦋 Bot");
    expect(bot.matches("clawd ・🦋 bot status")).toBe(true);
    expect(bot.matches("clawd bot status")).toBe(false);
    expect(bot.matches("clawd🦋bot status")).toBe(false);
  });

  it("keeps a trailing non-emoji variation sequence required", () => {
    const bot = mention("Bot$️");
    expect(bot.matches("bot$️ status")).toBe(true);
    expect(bot.matches("bot status")).toBe(false);
    expect(bot.strip("bot /status")).toBe("bot /status");
  });

  it("normalizes a joiner-only gap without accepting whitespace", () => {
    const bot = mention("क‍ख");
    expect(bot.matches("क‍ख नमस्ते")).toBe(true);
    expect(bot.matches("कख नमस्ते")).toBe(true);
    expect(bot.matches("क ख नमस्ते")).toBe(false);
    expect(bot.matches("@क ख नमस्ते")).toBe(false);
    expect(bot.strip("क ख नमस्ते")).toBe("क ख नमस्ते");
    expect(bot.strip("क‍ख /status")).toBe("/status");
  });

  it("strips a spaced gap whose raw spelling also carries a joiner", () => {
    const bot = mention("क‍ ख");
    expect(bot.matches("क ख नमस्ते")).toBe(true);
    expect(bot.matches("कख नमस्ते")).toBe(false);
    expect(bot.strip("क‍ ख /status")).toBe("/status");
  });

  it("consumes leading decoration once without crossing a word boundary", () => {
    const bot = mention("🦋 小蝶");
    expect(bot.matches("小蝶 你好")).toBe(true);
    expect(bot.matches("🦋小蝶 你好")).toBe(true);
    expect(bot.matches("前🦋小蝶 你好")).toBe(false);
    expect(bot.strip("前🦋小蝶 /status")).toBe("前🦋小蝶 /status");
    expect(bot.strip("🦋 小蝶 /status")).toBe("/status");
    expect(bot.strip("🦋小蝶 /status")).toBe("/status");
    expect(bot.strip("🦋🦋小蝶 /status")).toBe("🦋 /status");
  });

  it("binds a variation selector to the decoration before it", () => {
    const bot = mention("❤️小蝶");
    expect(bot.matches("小蝶 你好")).toBe(true);
    expect(bot.matches("❤️小蝶 你好")).toBe(true);
    expect(bot.matches("前小蝶 你好")).toBe(false);
  });

  it("consumes trailing decoration once and preserves adjacent text", () => {
    const bot = mention("小蝶 🦋");
    expect(bot.matches("小蝶🦋 你好")).toBe(true);
    expect(bot.matches("小蝶 你好")).toBe(true);
    expect(bot.matches("小蝶🦋後續")).toBe(false);
    expect(bot.strip("小蝶🦋後續")).toBe("小蝶🦋後續");
    expect(bot.strip("小蝶 🦋 /status")).toBe("/status");
    expect(bot.strip("小蝶 /status")).toBe("/status");
    expect(bot.strip("小蝶🦋🦋 /status")).toBe("🦋 /status");
    expect(bot.strip("好的… 小蝶🦋 查天氣")).toBe("好的… 查天氣");
    expect(bot.strip("@小蝶🦋。查天氣")).toBe("。查天氣");
  });

  it("matches an emoji-only ZWJ identity that normalization splits apart", () => {
    const bot = mention("👩‍👧");
    expect(bot.matches("👩‍👧 status")).toBe(true);
    expect(bot.matches("👩👧 status")).toBe(true);
    expect(bot.matches("👩 status")).toBe(false);
    expect(bot.strip("👩‍👧 /status")).toBe("/status");
  });

  it("matches a configured identity emoji that carries a joiner", () => {
    const bot = mention("Clawd", "👩‍👧");
    expect(bot.matches("👩‍👧 status")).toBe(true);
    expect(bot.matches("clawd status")).toBe(true);
  });

  it("accepts the identity's numeric keycap without accepting bare or foreign digits", () => {
    const bot = mention("Bot1️⃣");
    expect(bot.matches("bot 早安")).toBe(true);
    expect(bot.matches("bot1️⃣ 早安")).toBe(true);
    expect(bot.matches("bot1 早安")).toBe(false);
    expect(bot.matches("botx 早安")).toBe(false);
    expect(bot.matches("bot3️⃣ 早安")).toBe(false);
    expect(bot.strip("bot /status")).toBe("/status");
    expect(bot.strip("bot1️⃣ /status")).toBe("/status");
    expect(bot.strip("bot1 /status")).toBe("bot1 /status");
    expect(bot.strip("bot3️⃣ /status")).toBe("bot3️⃣ /status");
  });

  it("does not treat a foreign keycap as decoration for a plain name", () => {
    const bot = mention("Bot");
    expect(bot.matches("bot1️⃣ hello")).toBe(false);
    expect(bot.strip("bot1️⃣ /status")).toBe("bot1️⃣ /status");
  });

  it("reads spaced interior decoration once while keeping a separator floor", () => {
    const bot = mention("Clawd 🦋 ★ Bot");
    expect(bot.matches("clawd 🦋 ★ bot status")).toBe(true);
    expect(bot.matches("clawd🦋★bot status")).toBe(true);
    expect(bot.matches("clawd bot status")).toBe(true);
    expect(bot.matches("clawd 🦋 🦋 ★ bot status")).toBe(false);
    expect(bot.matches("clawdbot status")).toBe(false);
    expect(bot.matches("@clawdbot status")).toBe(false);
  });

  it("derives no pattern from an identity that normalization empties", () => {
    const bot = mention("\u200D");
    expect(bot.regexes).toHaveLength(0);
    expect(bot.matches("hello!")).toBe(false);
  });

  it("keeps a joiner-only identity emoji from matching everything", () => {
    const bot = mention("Clawd", "\u200D");
    expect(bot.regexes).toHaveLength(1);
    expect(bot.matches("hello!")).toBe(false);
    expect(bot.matches("clawd hello")).toBe(true);
  });

  it("requires the complete emoji identity, not its bare variation selector", () => {
    const bot = mention("❤️");
    expect(bot.matches("❤️ status")).toBe(true);
    expect(bot.matches("☀️ status")).toBe(false);
    expect(bot.strip("❤️ /status")).toBe("/status");
    expect(bot.strip("☀️ /status")).toBe("☀️ /status");
  });

  it("keeps a combining mark inside a written name required", () => {
    const bot = mention("Jose\u0301🦋");
    expect(bot.matches("jose\u0301 hello")).toBe(true);
    expect(bot.matches("jose hello")).toBe(false);
  });

  it("strips markless edge joiners without stripping part of a joined word", () => {
    const trailing = mention("क‍");
    const leading = mention("‍क");
    expect(trailing.matches("क नमस्ते")).toBe(true);
    expect(leading.matches("क नमस्ते")).toBe(true);
    expect(trailing.strip("क‍ /status")).toBe("/status");
    expect(leading.strip("‍क /status")).toBe("/status");
    expect(trailing.strip("क /status")).toBe("/status");
    expect(trailing.matches("कख नमस्ते")).toBe(false);
    expect(trailing.strip("क‍ख नमस्ते")).toBe("क‍ख नमस्ते");
  });

  it("strips edge decoration reached across a raw joiner", () => {
    const bot = mention("क‍🦋");
    expect(bot.matches("क🦋 नमस्ते")).toBe(true);
    expect(bot.matches("क नमस्ते")).toBe(true);
    expect(bot.strip("क‍🦋 /status")).toBe("/status");
  });

  it("rejects a long joined suffix without quadratic stripping", () => {
    const bot = mention("Bot🦋");
    const message = `Bot${"\u200D".repeat(32_768)}X /status`;
    const startedAt = performance.now();
    expect(bot.strip(message)).toBe(message);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("keeps whitespace between plain words required", () => {
    const bot = mention("Clawd Bot");
    expect(bot.matches("clawd bot status")).toBe(true);
    expect(bot.matches("clawdbot status")).toBe(false);
  });
});
