import { expect, it, vi } from "vitest";
import { assistantVisibleTextFilters } from "./assistant-visible-text.js";
import { createTextProjection } from "./text-projection.js";

it("bounds prefix comparisons after a stripped trace line", () => {
  const answer =
    Array.from({ length: 256 }, (_, index) => `Step ${index}: ordinary prose.\n`).join("") +
    "Done.";
  const source = 'tool call: hidden {"path":"notes.md"}\n' + answer;
  const stream = createTextProjection(assistantVisibleTextFilters("delivery", true));
  const probe = vi.spyOn(String.prototype, "startsWith");
  let comparedCharacters = 0;
  let delivered = "";
  try {
    for (let offset = 0; offset < source.length; offset += 4) {
      const result = stream.append(source.slice(offset, offset + 4));
      delivered = result.delta === null ? result.text : delivered + result.delta;
    }
    comparedCharacters = probe.mock.calls.reduce((sum, [search]) => sum + search.length, 0);
  } finally {
    probe.mockRestore();
  }
  expect(stream.text).toBe(answer);
  expect(delivered).toBe(answer);
  expect(comparedCharacters).toBeGreaterThan(0);
  expect(comparedCharacters).toBeLessThan(source.length * 64);
});

it("keeps a trailing high surrogate pending until its visibility is known", () => {
  const stream = createTextProjection(assistantVisibleTextFilters("delivery", true));
  expect(stream.append("\uDB40")).toEqual({ text: "", delta: "" });
  expect(stream.append("\uDC67")).toEqual({ text: "", delta: "" });
  expect(stream.append("Answer")).toEqual({
    text: "\uDB40\uDC67Answer",
    delta: "\uDB40\uDC67Answer",
  });
  expect(stream.replace("\uDB40")).toEqual({ text: "", delta: null });
  expect(stream.append("x").text).toBe("\uDB40x");
  expect(stream.replace("\uD83D").text).toBe("");
  expect(stream.append("\uDE00").text).toBe("😀");
});

it("bounds classification work while invisible text streams", () => {
  const source = "\u200B".repeat(1024);
  const stream = createTextProjection(assistantVisibleTextFilters("delivery", true));
  const probe = vi.spyOn(RegExp.prototype, "test");
  let testedCharacters = 0;
  try {
    for (const char of source) {
      stream.append(char);
    }
    testedCharacters = probe.mock.calls.reduce((sum, [text]) => sum + text.length, 0);
  } finally {
    probe.mockRestore();
  }
  expect(stream.text).toBe("");
  expect(testedCharacters).toBeGreaterThan(0);
  expect(testedCharacters).toBeLessThan(source.length * 128);
  expect(stream.append("Visible")).toEqual({ text: source + "Visible", delta: source + "Visible" });
  expect(stream.replace("\u2060")).toEqual({ text: "", delta: null });
});
