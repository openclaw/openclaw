import { describe, expect, it, vi } from "vitest";
import {
  assistantVisibleTextFilters,
  sanitizeAssistantVisibleTextWithProfile,
} from "./assistant-visible-text.js";
import { modelSpecialTokensTextFilter, stripModelSpecialTokens } from "./model-special-tokens.js";
import { createTextProjection } from "./text-projection.js";

function streamSource(source: string, chunkSize: number) {
  const projection = createTextProjection([modelSpecialTokensTextFilter]);
  let delivered = "";
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    const { text, delta } = projection.append(source.slice(offset, offset + chunkSize));
    delivered = delta === null ? text : delivered + delta;
  }
  return { text: projection.text, delivered };
}

const chunkSizes = [1, 2, 3, 4, 5, 7, 64];

const sources: Array<[string, string]> = [
  ["leaked token at the start", "<|assistant|>Hello there."],
  ["token between words", "Hello<|assistant|>world"],
  ["adjacent tokens", "first<|user|><|assistant|>second"],
  ["token at the end", "Hello<|assistant|>"],
  ["token at the end before a word", "Hello<|assistant|>World"],
  ["full-width DeepSeek token", "<｜begin▁of▁sentence｜>Hello there"],
  ["tokens inside a fence", "```text\n<|assistant|>\n```\nVisible text."],
  ["token inside a tilde fence", "~~~text\n<|assistant|>\n~~~\nVisible text."],
  ["token inside inline code", "`<|assistant|>` stays visible."],
  ["token inside inline code with trailing text", "Use `<|assistant|> tokens` carefully."],
  ["escaped backtick before an inline token", "Use \\` and `<|assistant|> tokens` here."],
  ["closer run revokes an inline span", "`<|assistant|>``"],
  ["longer closer run revokes an inline span", "`<|assistant|>```"],
  ["token body containing an angle bracket", "head <|a<b|> tail"],
  ["prose pipe operators", "Elm: use <| for application.\n\nLater: chain with |> instead."],
  ["token beside astral letters", "𐐀<|assistant|>𐐁"],
  ["token beside a combining mark", "cafe\u0301<|assistant|>word"],
  ["token beside punctuation", "Hello<|assistant|>."],
  ["markup without tokens", "<div>x</div>\n<|assistant|>done"],
  ["plain prose without tokens", "The gateway streams the reply without control tokens."],
];

describe("model special token streaming", () => {
  it.each(sources)("matches the batch transform for %s", (name, source) => {
    const batch = stripModelSpecialTokens(source);
    for (const chunkSize of chunkSizes) {
      const result = streamSource(source, chunkSize);
      expect(result.text, `${name} at ${chunkSize} chars`).toBe(batch);
      expect(result.delivered, `${name} deltas at ${chunkSize} chars`).toBe(batch);
    }
  });

  it("completes a token whose opener is split across deltas", () => {
    const projection = createTextProjection([modelSpecialTokensTextFilter]);
    const result = projection.append("a<|assist");
    const rest = projection.append("ant|>b");
    const text = rest.delta === null ? rest.text : result.text + rest.delta;
    expect(text).toBe("a b");
  });

  it("keeps a token at the end pending until the separator is known", () => {
    const projection = createTextProjection([modelSpecialTokensTextFilter]);
    expect(projection.append("Hello<|assistant|>").text).toBe("Hello");
    expect(projection.append("World").text).toBe("Hello World");
    expect(projection.append("!").text).toBe("Hello World!");
  });

  it("replays a replacement through the canonical transform", () => {
    const projection = createTextProjection([modelSpecialTokensTextFilter]);
    expect(projection.replace("<|assistant|>Hello").text).toBe("Hello");
    expect(projection.append(" there").text).toBe("Hello there");
  });

  it("matches the batch transform at every prefix", () => {
    for (const [_name, source] of sources) {
      const projection = createTextProjection([modelSpecialTokensTextFilter]);
      for (let end = 1; end <= source.length; end++) {
        projection.append(source.slice(end - 1, end));
        expect(projection.text, `prefix ${end} of ${JSON.stringify(source)}`).toBe(
          stripModelSpecialTokens(source.slice(0, end)),
        );
      }
    }
  });

  it("matches the batch delivery profile when a token becomes code-owned later", () => {
    const source = "Use `<|assistant|> tokens` carefully.";
    const batch = sanitizeAssistantVisibleTextWithProfile(source, "delivery", false);
    for (const chunkSize of chunkSizes) {
      const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        projection.append(source.slice(offset, offset + chunkSize));
      }
      expect(projection.text, `delivery profile at ${chunkSize} chars`).toBe(batch);
    }
  });

  it("scans a bounded prefix with tilde-dense prose", () => {
    const source = `<|assistant|>${"Latency is about ~12 ms at ~50% load. ".repeat(500).trimEnd()}`;
    expect(source.length).toBeGreaterThan(16_000);
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
    const probe = vi.spyOn(RegExp.prototype, "test");
    let tokenScanCharacters = 0;
    try {
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
      probe.mock.calls.forEach(([value], index) => {
        const regex = probe.mock.instances[index] as RegExp | undefined;
        if (regex?.source.startsWith("<[|｜]")) {
          tokenScanCharacters += value.length;
        }
      });
    } finally {
      probe.mockRestore();
    }
    expect(projection.text).toBe(source.slice("<|assistant|>".length));
    // A single "~" cannot change code ownership, so only the token delta may re-scan.
    expect(tokenScanCharacters).toBeLessThan(source.length * 4);
  });

  it("scans a bounded prefix after a leaked token and a lone backtick", () => {
    const answer = Array.from(
      { length: 400 },
      (_value, index) => `Step ${index}: ordinary prose about the release.`,
    ).join("\n");
    const source = `<|assistant|>${answer.slice(0, 8_000)} a lone \` tick ${answer.slice(8_000)}`;
    expect(source.length).toBeGreaterThan(16_000);
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
    const probe = vi.spyOn(RegExp.prototype, "test");
    let tokenScanCharacters = 0;
    try {
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
      probe.mock.calls.forEach(([value], index) => {
        const regex = probe.mock.instances[index] as RegExp | undefined;
        if (regex?.source.startsWith("<[|｜]")) {
          tokenScanCharacters += value.length;
        }
      });
    } finally {
      probe.mockRestore();
    }
    expect(projection.text).toBe(source.slice("<|assistant|>".length));
    // Only the token and the backtick delta may re-run the canonical token scan.
    expect(tokenScanCharacters).toBeLessThan(source.length * 4);
  });

  it("scans a bounded prefix after a leaked token", () => {
    const answer = Array.from(
      { length: 400 },
      (_value, index) => `Step ${index}: ordinary prose about the release.`,
    ).join("\n");
    const source = `<|assistant|>${answer}`;
    expect(source.length).toBeGreaterThan(16_000);
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
    const probe = vi.spyOn(RegExp.prototype, "test");
    let tokenScanCharacters = 0;
    try {
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
      probe.mock.calls.forEach(([value], index) => {
        const regex = probe.mock.instances[index] as RegExp | undefined;
        if (regex?.source.startsWith("<[|｜]")) {
          tokenScanCharacters += value.length;
        }
      });
    } finally {
      probe.mockRestore();
    }
    expect(projection.text).toBe(answer);
    // The canonical scan may run for the token's deltas, never for every later delta.
    expect(tokenScanCharacters).toBeLessThan(source.length * 4);
  });
});
