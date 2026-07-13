import { describe, expect, it } from "vitest";
import { buildUsageContract } from "./contract.js";
import { DEFAULT_USAGE_BAR_TEMPLATE } from "./default-template.js";
import { renderUsageBar, type UsageBarTemplate } from "./translator.js";

const SCALES = {
  braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
  moon: "🌑🌘🌗🌖🌕",
  weather: ["🥶", "☁️", "🌥", "⛅️", "🌤", "☀️"],
  plants: ["🪾", "🍂", "🌱", "☘️", "🍀", "🌿"],
};

function tpl(pieces: unknown[]): UsageBarTemplate {
  return {
    scales: SCALES,
    aliases: { models: { "claude-opus-4-6": "opus46" }, reasoning: { medium: "med" } },
    output: { sep: "", surfaces: { discord: pieces } },
  };
}

function render(pieces: unknown[], contract: Record<string, unknown>): string {
  return renderUsageBar(tpl(pieces), { surface: "discord", ...contract });
}

describe("usage-bar verbs", () => {
  it("num — compact counts", () => {
    expect(render([{ text: "{usage.input_tokens|num}" }], { usage: { input_tokens: 3000 } })).toBe(
      "3.0k",
    );
    expect(render([{ text: "{x|num}" }], { x: 272000 })).toBe("272k");
    expect(render([{ text: "{x|num}" }], { x: 128 })).toBe("128");
  });

  it("fixed — fixed-decimal precision", () => {
    expect(render([{ text: "{cost|fixed:4}" }], { cost: 0.03771985 })).toBe("0.0377");
    expect(render([{ text: "{cost|fixed}" }], { cost: 1.5 })).toBe("1.50");
    expect(render([{ text: "{cost|fixed:0}" }], { cost: 2.7 })).toBe("3");
    expect(render([{ text: "{cost|fixed:4}" }], { cost: "nope" })).toBe("");
  });

  it("dur — seconds to reset", () => {
    expect(render([{ text: "{x|dur}" }], { x: 14820 })).toBe("4h07m");
    expect(render([{ text: "{x|dur}" }], { x: 449280 })).toBe("5.2d");
    expect(render([{ text: "{x|dur}" }], { x: 1980 })).toBe("33m");
  });

  it("pct and inv", () => {
    expect(render([{ text: "{x|pct}" }], { x: 96 })).toBe("96%");
    expect(render([{ text: "{x|inv|pct}" }], { x: 75 })).toBe("25%");
  });

  it("meter — multi-cell braille bar", () => {
    expect(render([{ text: "[{x|meter:5:braille}]" }], { x: 75 })).toBe("[⣿⣿⣿⣧⠐]");
    expect(render([{ text: "[{x|meter:5:braille}]" }], { x: 0 })).toBe("[⠐⠐⠐⠐⠐]");
    expect(render([{ text: "[{x|meter:5:braille}]" }], { x: 100 })).toBe("[⣿⣿⣿⣿⣿]");
  });

  it("meter:1 — single glyph, codepoint-correct for astral scales", () => {
    expect(render([{ text: "{x|meter:1:moon}" }], { x: 0 })).toBe("🌑");
    expect(render([{ text: "{x|meter:1:moon}" }], { x: 50 })).toBe("🌗");
    expect(render([{ text: "{x|meter:1:moon}" }], { x: 100 })).toBe("🌕");
  });

  it("alias — listed shortens, unlisted echoes through", () => {
    expect(render([{ text: "{m|alias:models}" }], { m: "claude-opus-4-6" })).toBe("opus46");
    expect(render([{ text: "{m|alias:models}" }], { m: "some-new-model" })).toBe("some-new-model");
  });

  it("alias — prototype keys (toString, constructor) do not match inherited properties", () => {
    // When a model is named "toString" or "constructor", the `in` operator
    // would match Object.prototype inherited properties and return
    // Object.prototype.toString (a function) instead of the raw key.
    // After the fix (Object.hasOwn), these should echo through unchanged.
    expect(render([{ text: "{m|alias:models}" }], { m: "toString" })).toBe("toString");
    expect(render([{ text: "{m|alias:models}" }], { m: "constructor" })).toBe("constructor");
    expect(render([{ text: "{m|alias:models}" }], { m: "valueOf" })).toBe("valueOf");
    expect(render([{ text: "{m|alias:models}" }], { m: "__proto__" })).toBe("__proto__");
  });

  it("fallback when path is missing/empty", () => {
    expect(render([{ text: "{identity.emoji|🤖} hi" }], {})).toBe("🤖 hi");
    expect(render([{ text: "{identity.emoji|🤖} hi" }], { identity: { emoji: "🩺" } })).toBe(
      "🩺 hi",
    );
  });
});

describe("usage-bar segment forms", () => {
  it("when drops on null/false/empty, keeps on 0", () => {
    const seg = [{ when: "u.cache_hit_pct", text: "🗄 {u.cache_hit_pct|pct}" }];
    expect(render(seg, { u: {} })).toBe("");
    expect(render(seg, { u: { cache_hit_pct: 0 } })).toBe("🗄 0%");
  });

  it("map resolves enum/bool, drops on no match", () => {
    const seg = [{ map: "state.fast_mode", cases: { true: "⚡", false: "🐌" } }];
    expect(render(seg, { state: { fast_mode: true } })).toBe("⚡");
    expect(render(seg, { state: { fast_mode: false } })).toBe("🐌");
    expect(render(seg, { state: {} })).toBe("");
  });

  it("map — prototype keys (toString, constructor) do not match inherited properties", () => {
    // When the map key is "toString" or "constructor", the `in` operator
    // would incorrectly match Object.prototype inherited properties and
    // return undefined (Object.prototype.toString is a function, not a
    // string case value) instead of falling through to _default.
    const seg = [
      { map: "state.mode", cases: { toString: "should-not-match", _default: "fallback" } },
    ];
    expect(render(seg, { state: { mode: "toString" } })).toBe("should-not-match");
    expect(render(seg, { state: { mode: "constructor" } })).toBe("fallback");
  });

  it("each with item_scales picks a scale per window by position", () => {
    const seg = [
      {
        text: "W",
        each: "windows",
        item: "{pct_left|meter:1:*}{resets_in_s|dur}",
        item_scales: ["weather", "plants"],
      },
    ];
    const out = render(seg, {
      windows: [
        { pct_left: 92, resets_in_s: 17100 },
        { pct_left: 70, resets_in_s: 570240 },
      ],
    });
    expect(out).toBe("W ☀️4h45m 🍀6.6d");
  });

  it("each drops the whole segment when the array is empty", () => {
    expect(render([{ text: "W", each: "windows", item: "{x}" }], {})).toBe("");
  });
});

describe("usage-bar end-to-end with buildUsageContract", () => {
  it("renders a full footer from a reply usage snapshot", () => {
    const contract = buildUsageContract(
      {
        provider: "openai",
        model: "claude-opus-4-6",
        reasoningEffort: "medium",
        fastMode: false,
        fallbackUsed: false,
        contextTokenBudget: 272000,
        contextUsedTokens: 204000,
        usage: { input: 204000, output: 15, cacheRead: 0, cacheWrite: 0, total: 204015 },
        turnUsd: 0.03771985,
      },
      "discord",
    );
    const pieces = [
      { text: "{model.display_name|alias:models}" },
      { map: "model.is_fallback", cases: { true: "🔄" } },
      { text: " | " },
      { when: "model.reasoning", text: "{model.reasoning|alias:reasoning}" },
      { map: "state.fast_mode", cases: { true: "⚡", false: "🐌" } },
      { text: " | 📚 [{context.pct_used|meter:5:braille}]{context.max_tokens|num}" },
      { text: " | ${cost.turn_usd|fixed:4}" },
    ];
    expect(renderUsageBar(tpl(pieces), contract)).toBe("opus46 | med🐌 | 📚 [⣿⣿⣿⣧⠐]272k | $0.0377");
  });
});

// ── Braille character range constants used across webchat surface tests ──
const BRAILLE_BLOCK_START = 0x2800;
const BRAILLE_BLOCK_END = 0x28ff;
const BLOCK_ELEMENTS_START = 0x2580;
const BLOCK_ELEMENTS_END = 0x259f;

function isBraille(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return cp >= BRAILLE_BLOCK_START && cp <= BRAILLE_BLOCK_END;
}

function isBlockElement(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return cp >= BLOCK_ELEMENTS_START && cp <= BLOCK_ELEMENTS_END;
}

function hasAnyBraille(text: string): boolean {
  return Array.from(text).some(isBraille);
}

function hasAnyBlockElement(text: string): boolean {
  return Array.from(text).some(isBlockElement);
}

/**
 * Build a realistic reply-usage state sufficient to exercise the default
 * template's context-meter segment (which is where braille/block lives).
 */
function usageState(overrides?: Partial<Parameters<typeof buildUsageContract>[0]>) {
  return buildUsageContract(
    {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      fastMode: false,
      fallbackUsed: false,
      contextTokenBudget: 200000,
      contextUsedTokens: 150000,
      usage: { input: 50000, output: 2000, cacheRead: 30000, cacheWrite: 0, total: 82000 },
      turnUsd: 0.15,
      sessionId: "test-session",
      agentId: "test-agent",
      ...overrides,
    },
    undefined as unknown as string, // patched per test
  );
}

describe("webchat surface — braille-free rendering", () => {
  it("webchat surface produces NO braille-pattern characters (U+2800–U+28FF)", () => {
    const contract = { ...usageState(), surface: "webchat" };
    const output = renderUsageBar(DEFAULT_USAGE_BAR_TEMPLATE, contract);
    expect(output).not.toBe("");
    expect(hasAnyBraille(output)).toBe(false);
  });

  it("webchat surface uses block-element scale (U+2580–U+259F) instead of braille", () => {
    const contract = { ...usageState(), surface: "webchat" };
    const output = renderUsageBar(DEFAULT_USAGE_BAR_TEMPLATE, contract);
    expect(hasAnyBlockElement(output)).toBe(true);
  });

  it("webchat surface context meter is visually a 5-char progress bar", () => {
    const contract = { ...usageState(), surface: "webchat" };
    const output = renderUsageBar(DEFAULT_USAGE_BAR_TEMPLATE, contract);
    // The block scale meter produces 5 contiguous block-element glyphs.
    const blockChars = Array.from(output).filter(isBlockElement);
    expect(blockChars.length).toBe(5);
  });

  it("renders webchat surface end-to-end via buildUsageContract with explicit 'webchat' channel", () => {
    const contract = buildUsageContract(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        reasoningEffort: "medium",
        fastMode: false,
        fallbackUsed: false,
        contextTokenBudget: 200000,
        contextUsedTokens: 150000,
        usage: { input: 50000, output: 2000, cacheRead: 30000, cacheWrite: 0, total: 82000 },
        turnUsd: 0.15,
      },
      "webchat",
    );
    const output = renderUsageBar(DEFAULT_USAGE_BAR_TEMPLATE, contract);
    expect(hasAnyBraille(output)).toBe(false);
    expect(hasAnyBlockElement(output)).toBe(true);
    // The provider + model alias + reasoning + fast_mode should still render.
    expect(output).toMatch(/anthropic/);
    expect(output).toMatch(/sonnet46/);
  });
});

describe("surface fallback — non-webchat surfaces keep braille", () => {
  it("default surface (unmatched channel) still uses braille scale", () => {
    const contract = { ...usageState(), surface: "terminal" };
    const output = renderUsageBar(DEFAULT_USAGE_BAR_TEMPLATE, contract);
    expect(hasAnyBraille(output)).toBe(true);
    expect(hasAnyBlockElement(output)).toBe(false);
  });

  it("discord surface still uses braille scale", () => {
    const contract = { ...usageState(), surface: "discord" };
    const output = renderUsageBar(DEFAULT_USAGE_BAR_TEMPLATE, contract);
    expect(hasAnyBraille(output)).toBe(true);
  });

  it("null surface falls back to default (braille)", () => {
    const contract = { ...usageState(), surface: null };
    const output = renderUsageBar(DEFAULT_USAGE_BAR_TEMPLATE, contract);
    expect(hasAnyBraille(output)).toBe(true);
  });

  it("undefined surface key falls back to default (braille)", () => {
    const contract = usageState();
    const output = renderUsageBar(DEFAULT_USAGE_BAR_TEMPLATE, contract);
    expect(hasAnyBraille(output)).toBe(true);
  });
});

describe("braille U+2800–U+28FF — evidence for markdown-it misdetection", () => {
  /**
   * Issue #105481 reports that Braille Pattern characters (U+2800–U+28FF) in
   * the usage-bar meter cause markdown-it's Uint16Array-based content decoder
   * to misidentify the message payload as binary/attachment data, rendering
   * tool output as images instead of text in WebChat.
   *
   * The fix swaps the meter scale from "braille" (U+2800–U+28FF) to "block"
   * (U+2580–U+259F) for the webchat surface only. These tests verify:
   * 1. Every glyph in the braille scale IS in the reported U+2800-U+28FF range
   * 2. Every glyph in the block scale is OUTSIDE the braille range
   * 3. WebChat surface output contains zero U+2800-U+28FF characters
   */

  // Narrow the template scales to a usable index type (UsageBarTemplate is Record<string, unknown>).
  const TPL_SCALES = DEFAULT_USAGE_BAR_TEMPLATE.scales as
    | Record<string, string | string[]>
    | undefined;

  it("every braille-scale glyph falls in the reported U+2800–U+28FF range", () => {
    const brailleScale = TPL_SCALES?.["braille"];
    expect(brailleScale).toBeDefined();
    const chars = String(brailleScale ?? "");
    expect(chars.length).toBeGreaterThan(0);
    for (const ch of chars) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp).toBeGreaterThanOrEqual(BRAILLE_BLOCK_START);
      expect(cp).toBeLessThanOrEqual(BRAILLE_BLOCK_END);
    }
    // Document the exact code points for the review record.
    const codePoints = Array.from(chars).map(
      (ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
    );
    expect(codePoints).toEqual([
      "U+2810", // ⠐
      "U+2840", // ⡀
      "U+2844", // ⡄
      "U+2846", // ⡆
      "U+2847", // ⡇
      "U+28C7", // ⣇
      "U+28E7", // ⣧
      "U+28F7", // ⣷
      "U+28FF", // ⣿
    ]);
  });

  it("no block-scale glyph falls in the braille U+2800–U+28FF range", () => {
    const blockScale = TPL_SCALES?.["block"];
    expect(blockScale).toBeDefined();
    const chars = String(blockScale ?? "");
    expect(chars.length).toBeGreaterThan(0);
    for (const ch of chars) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp < BRAILLE_BLOCK_START || cp > BRAILLE_BLOCK_END).toBe(true);
    }
  });

  it("every block-scale glyph falls in the Block Elements U+2580–U+259F range", () => {
    const blockScale = TPL_SCALES?.["block"];
    expect(blockScale).toBeDefined();
    const chars = String(blockScale ?? "");
    for (const ch of chars) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp).toBeGreaterThanOrEqual(BLOCK_ELEMENTS_START);
      expect(cp).toBeLessThanOrEqual(BLOCK_ELEMENTS_END);
    }
  });

  it("braille and block scales share zero overlapping code points", () => {
    const brailleChars = new Set(
      Array.from(String(TPL_SCALES?.["braille"] ?? "")).map((ch) => ch.codePointAt(0) ?? 0),
    );
    const blockChars = Array.from(String(TPL_SCALES?.["block"] ?? "")).map(
      (ch) => ch.codePointAt(0) ?? 0,
    );
    for (const cp of blockChars) {
      expect(brailleChars.has(cp)).toBe(false);
    }
  });
});
