import { expect, it } from "vitest";
import { renderUsageBar, type UsageBarTemplate } from "./translator.js";

function tpl(pieces: unknown[]): UsageBarTemplate {
  return {
    scales: {
      braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
      moon: "🌑🌘🌗🌖🌕",
      weather: ["🥶", "☁️", "🌥", "⛅️", "🌤", "☀️"],
      plants: ["🪾", "🍂", "🌱", "☘️", "🍀", "🌿"],
    },
    aliases: { models: { "claude-opus-4-6": "opus46" }, reasoning: { medium: "med" } },
    output: { sep: "", surfaces: { discord: pieces } },
  };
}

function render(piece: unknown, contract: Record<string, unknown>): string {
  return renderUsageBar(tpl([piece]), { surface: "discord", ...contract });
}
it.each<[string, Record<string, unknown>, string]>([
  ["x|num", { x: 272000 }, "272k"],
  ["x|num", { x: 128 }, "128"],
  ["x|num", { x: 1_000_000 }, "1.0m"],
  ["x|num", { x: 1_048_576 }, "1.0m"],
  ["x|num", { x: 2_000_000 }, "2.0m"],
  ["x|num", { x: -1_500_000 }, "-1.5m"],
  ["x|num", { x: -10_500 }, "-10k"],
  ["x|num", { x: 999_950 }, "1000k"],
  ["x|num", { x: true }, "1"],
  ["x|fixed", { x: true }, "1.00"],
  ["x|dur", { x: true }, "0m"],
  ["x|pct", { x: true }, "1%"],
  ["x|inv", { x: true }, "99"],
  ["x|num|missing", { x: "nope" }, ""],
  ["x|num|inv|pct", { x: "nope" }, ""],
  ["x|fixed:-1|inv|pct", { x: 25 }, ""],
  ["x|meter:1:moon", { x: 0 }, "🌑"],
  ["x|meter:1:moon", { x: 50 }, "🌗"],
  ["x|meter:1:moon", { x: 100 }, "🌕"],
  ["x|meter::braille", { x: 75 }, "⣿⣿⣿⣧⠐"],
  ["x|meter:   :braille", { x: 75 }, "⣿⣿⣿⣧⠐"],
  ["x|meter:+5:braille", { x: 75 }, "⣿⣿⣿⣧⠐"],
  ["x|meter: 5 :braille", { x: 75 }, "⣿⣿⣿⣧⠐"],
  ["x|meter:abc:braille", { x: 75 }, ""],
  ["x|alias:models", { x: "claude-opus-4-6" }, "opus46"],
  ["x|alias:models", { x: "some-new-model" }, "some-new-model"],
  ["x|alias:models", { x: "toString" }, "toString"],
  ["x|alias:models", { x: "constructor" }, "constructor"],
  ["x|alias:models", { x: "valueOf" }, "valueOf"],
  ["x|alias:models", { x: "__proto__" }, "__proto__"],
  ["usage.input_tokens|num", { usage: { input_tokens: 3000 } }, "3.0k"],
  ["x|num|missing", {}, "missing"],
])("%s formats %j as %s", (expression, contract, expected) => {
  expect(render({ text: `{${expression}}` }, contract)).toBe(expected);
});

it("preserves an alias-produced empty string through numeric verbs", () => {
  for (const verb of ["num", "fixed", "dur", "pct", "inv"]) {
    const template = tpl([{ text: `{x|alias:numbers|${verb}}` }]);
    template.aliases = { numbers: { empty: "" } };
    expect(renderUsageBar(template, { surface: "discord", x: "empty" })).toBe("");
  }
});

it("supports the maximum meter width", () => {
  expect(render({ text: "{x|meter:100:braille}" }, { x: 50 })).toHaveLength(100);
});

it("when drops on null/false/empty, keeps on 0", () => {
  const seg = { when: "u.cache_hit_pct", text: "🗄 {u.cache_hit_pct|pct}" };
  expect(render(seg, { u: {} })).toBe("");
  expect(render(seg, { u: { cache_hit_pct: 0 } })).toBe("🗄 0%");
});

it("map — prototype keys (toString, constructor) do not match inherited properties", () => {
  const seg = { map: "state.mode", cases: { toString: "should-not-match", _default: "fallback" } };
  expect(render(seg, { state: { mode: "toString" } })).toBe("should-not-match");
  expect(render(seg, { state: { mode: "constructor" } })).toBe("fallback");
});

it("each with item_scales picks a scale per window by position", () => {
  const seg = {
    text: "W",
    each: "windows",
    item: "{pct_left|meter:1:*}{resets_in_s|dur}",
    item_scales: ["weather", "plants"],
  };
  const out = render(seg, {
    windows: [
      { pct_left: 92, resets_in_s: 17100 },
      { pct_left: 70, resets_in_s: 570240 },
    ],
  });
  expect(out).toBe("W ☀️4h45m 🍀6.6d");
});

it("each drops the whole segment when the array is empty", () => {
  expect(render({ text: "W", each: "windows", item: "{x}" }, {})).toBe("");
});
