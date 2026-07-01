import { describe, expect, it } from "vitest";
import { buildUsageContract } from "./contract.js";
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

  it("alias — prototype keys do not match inherited properties", () => {
    const t = tpl([{ text: "{m|alias:models}" }]);
    // "toString" with explicit alias entry → returns the aliased value
    t.aliases.models["toString"] = "aliased";
    expect(renderUsageBar(t, { surface: "discord", m: "toString" })).toBe("aliased");
    // "constructor" without alias entry → passes through, does not hit Object.prototype
    expect(renderUsageBar(t, { surface: "discord", m: "constructor" })).toBe("constructor");
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

  it("map — prototype keys do not match inherited properties, fallback to _default", () => {
    const seg = [
      {
        map: "key",
        cases: { true: "yes", false: "no", _default: "fallback" },
      },
    ];
    // "toString" is an Object.prototype property — should NOT match, fallback to _default
    expect(render(seg, { key: "toString" })).toBe("fallback");
    // "constructor" is also inherited — should NOT match
    expect(render(seg, { key: "constructor" })).toBe("fallback");
    // Normal values still match correctly
    expect(render(seg, { key: "true" })).toBe("yes");
    expect(render(seg, { key: "other" })).toBe("fallback");
  });

  it("map resolves enum/bool, drops on no match", () => {
    const seg = [{ map: "state.fast_mode", cases: { true: "⚡", false: "🐌" } }];
    expect(render(seg, { state: { fast_mode: true } })).toBe("⚡");
    expect(render(seg, { state: { fast_mode: false } })).toBe("🐌");
    expect(render(seg, { state: {} })).toBe("");
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
