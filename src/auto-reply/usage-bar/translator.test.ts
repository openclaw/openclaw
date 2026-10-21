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
function expectVerb(verb: string, value: unknown, expected: string) {
  expect(render([{ text: `{x|${verb}}` }], { x: value })).toBe(expected);
}

describe("usage-bar translator", () => {
  it("num — compact counts", () => {
    expect(render([{ text: "{usage.input_tokens|num}" }], { usage: { input_tokens: 3000 } })).toBe(
      "3.0k",
    );
    expectVerb("num", 272000, "272k");
    expectVerb("num", 128, "128");
  });

  it("num formats millions while preserving signed thousands rounding", () => {
    expectVerb("num", 1_000_000, "1.0m");
    expectVerb("num", 1_048_576, "1.0m");
    expectVerb("num", 2_000_000, "2.0m");
    expectVerb("num", -1_500_000, "-1.5m");
    expectVerb("num", -10_500, "-10k");
    expectVerb("num", 999_950, "1000k");
  });

  it("preserves numeric verb coercion and formatting for true", () => {
    const expected = ["1", "1.00", "0m", "1%", "99"];
    for (const [index, verb] of ["num", "fixed", "dur", "pct", "inv"].entries()) {
      expectVerb(verb, true, expected[index]!);
    }
  });

  it("preserves an alias-produced empty string through numeric verbs", () => {
    for (const verb of ["num", "fixed", "dur", "pct", "inv"]) {
      const template = tpl([{ text: `{x|alias:numbers|${verb}}` }]);
      template.aliases = { numbers: { empty: "" } };
      expect(renderUsageBar(template, { surface: "discord", x: "empty" })).toBe("");
    }
  });

  it("keeps missing-path fallback separate from invalid numeric and empty pipeline results", () => {
    expect(render([{ text: "{x|num|missing}" }], {})).toBe("missing");
    expectVerb("num|missing", "nope", "");
    expectVerb("num|inv|pct", "nope", "");
    expectVerb("fixed:-1|inv|pct", 25, "");
  });

  it("meter:1 — single glyph, codepoint-correct for astral scales", () => {
    expectVerb("meter:1:moon", 0, "🌑");
    expectVerb("meter:1:moon", 50, "🌗");
    expectVerb("meter:1:moon", 100, "🌕");
  });

  it("meter — preserves default and supported explicit widths", () => {
    expectVerb("meter::braille", 75, "⣿⣿⣿⣧⠐");
    expectVerb("meter:   :braille", 75, "⣿⣿⣿⣧⠐");
    expectVerb("meter:+5:braille", 75, "⣿⣿⣿⣧⠐");
    expectVerb("meter: 5 :braille", 75, "⣿⣿⣿⣧⠐");
    expect(render([{ text: "{x|meter:100:braille}" }], { x: 50 })).toHaveLength(100);
  });

  it("meter — rejects invalid width abc", () => {
    expectVerb("meter:abc:braille", 75, "");
  });

  it("alias — listed shortens, unlisted echoes through", () => {
    expectVerb("alias:models", "claude-opus-4-6", "opus46");
    expectVerb("alias:models", "some-new-model", "some-new-model");
  });

  it("alias — prototype keys (toString, constructor) do not match inherited properties", () => {
    expectVerb("alias:models", "toString", "toString");
    expectVerb("alias:models", "constructor", "constructor");
    expectVerb("alias:models", "valueOf", "valueOf");
    expectVerb("alias:models", "__proto__", "__proto__");
  });
  it("when drops on null/false/empty, keeps on 0", () => {
    const seg = [{ when: "u.cache_hit_pct", text: "🗄 {u.cache_hit_pct|pct}" }];
    expect(render(seg, { u: {} })).toBe("");
    expect(render(seg, { u: { cache_hit_pct: 0 } })).toBe("🗄 0%");
  });

  it("map — prototype keys (toString, constructor) do not match inherited properties", () => {
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
