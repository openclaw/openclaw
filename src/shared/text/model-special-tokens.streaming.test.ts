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
  [
    "token inside an image label resolved by a late definition",
    "![a `<|assistant|>`][id]\n\n[id]: /url\n",
  ],
  ["token inside an image label with an inline destination", "![a `<|assistant|>`](/img.png)\n"],
  ["token inside an image title with an inline destination", '![a](/u "ti `<|assistant|>`tle")\n'],
  [
    "token inside an image label with a non-matching definition",
    "![a `<|assistant|>`][id]\n\n[other]: /url\n",
  ],
  [
    "token inside a shortcut image label resolved later",
    "![a `<|assistant|>`]\n\n[a `<|assistant|>`]: /url\n",
  ],
  [
    "token inside an image label whose definition continues on the next line",
    "![a `<|assistant|>`][id]\n\n[id]:\n /url\n",
  ],
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
  [
    "token restored when a reference definition is invalidated",
    "![a `<|assistant|>`][id]\n\n[id]: /url x",
  ],
  [
    "token restored when a definition title is invalidated",
    '![a `<|assistant|>`][id]\n\n[id]: /url "t" x',
  ],
  [
    "token restored when a next-line definition is invalidated",
    "![a `<|assistant|>`][id]\n\n[id]:\n/url x",
  ],
  [
    "tokens restored when a collapsed definition is invalidated",
    "![a `<|assistant|>`][]\n\n[a `<|assistant|>`]: /url x",
  ],
  [
    "tokens restored when a shortcut definition is invalidated",
    "![a `<|assistant|>`]\n\n[a `<|assistant|>`]: /url x",
  ],
  ["token stripped when a standalone definition settles", "[a `<|assistant|>`]: /url"],
  ["token kept when a standalone definition is invalidated", "[a `<|assistant|>`]: /url x"],
  ["token stripped in a definition after a settled paragraph", "hi\n\n[a `<|assistant|>`]: /url"],
  ["token stripped in a blockquote definition", "> [a `<|assistant|>`]: /url"],
  ["token stripped in an unordered-list definition", "- [a `<|assistant|>`]: /url"],
  ["token stripped in an ordered-list definition", "1. [a `<|assistant|>`]: /url"],
  ["token stripped in a container-nested definition", "> - [a `<|assistant|>`]: /url"],
  ["token kept while a definition title is still open", '[a `<|assistant|>`]: /url "t'],
  ["token kept inside link text with a destination", "[a `<|assistant|>`](url) stays visible."],
  [
    "token kept inside an unresolved reference label",
    "[a `<|assistant|>`][missing] stays visible.",
  ],
  [
    "token inside a definition label with an escaped closing bracket",
    "[a \\] `<|assistant|>`]: /url",
  ],
];

describe("model special token streaming", () => {
  it.each([
    ["escaped opener", "[a \\[ `<|assistant|>`]: /url", "[a \\[ ``]: /url"],
    ["link destination", "[a](`<|assistant|>`)", "[a](``)"],
    ["link title", '[a](/url "ti `<|assistant|>`tle")', '[a](/url "ti ``tle")'],
    ["table recognition", "`<|assistant|>`\n---|---|---", "``\n---|---|---"],
    ["table invalidation", "`<|assistant|>`\n---|---|---x", "`<|assistant|>`\n---|---|---x"],
    [
      "secondary image reference",
      "[`<|assistant|>`]: /url\n\n![a][`<|assistant|>`]",
      "[``]: /url\n\n![a][``]",
    ],
    ["code inside a token body", "[a <|`x`|>]: /url x", "[a <|`x`|>]: /url x"],
  ])("keeps prefix and delta parity across every split of %s", (_name, source, expected) => {
    expect(stripModelSpecialTokens(source)).toBe(expected);
    const check = (chunks: string[]) => {
      const projection = createTextProjection([modelSpecialTokensTextFilter]);
      let prefix = "";
      let delivered = "";
      for (const chunk of chunks) {
        prefix += chunk;
        const result = projection.append(chunk);
        delivered = result.delta === null ? result.text : delivered + result.delta;
        const batch = stripModelSpecialTokens(prefix);
        expect(result.text, JSON.stringify(chunks)).toBe(batch);
        expect(delivered, JSON.stringify(chunks)).toBe(batch);
      }
      expect(delivered).toBe(expected);
    };
    for (let split = 1; split < source.length; split++) {
      check([source.slice(0, split), source.slice(split)]);
    }
    for (const size of [1, 4]) {
      check(
        Array.from({ length: Math.ceil(source.length / size) }, (_, index) =>
          source.slice(index * size, (index + 1) * size),
        ),
      );
    }
  });

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

  it("matches the batch transform when a late definition revokes a kept token", () => {
    const source = "![a `<|assistant|>`][id]\n\n[id]: /url\n";
    const batch = stripModelSpecialTokens(source);
    expect(batch).toBe("![a ``][id]\n\n[id]: /url\n");
    for (const chunkSize of chunkSizes) {
      const result = streamSource(source, chunkSize);
      expect(result.text, `revoked token text at ${chunkSize} chars`).toBe(batch);
      expect(result.delivered, `revoked token deltas at ${chunkSize} chars`).toBe(batch);
    }
  });

  it("matches the delivery profile when image completion revokes a kept token", () => {
    const source = "![a `<|assistant|>`](/img.png)";
    const batch = sanitizeAssistantVisibleTextWithProfile(source, "delivery", false);
    expect(batch).toBe("![a ``](/img.png)");
    for (const chunkSize of chunkSizes) {
      const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        projection.append(source.slice(offset, offset + chunkSize));
      }
      expect(projection.text, `completed image at ${chunkSize} chars`).toBe(batch);
    }
  });
  const answer = Array.from(
    { length: 400 },
    (_value, index) => `Step ${index}: ordinary prose about the release.`,
  ).join("\n");
  const tildeAnswer = "Latency is about ~12 ms at ~50% load. ".repeat(500).trimEnd();
  const quotedAnswer = "Use `<|assistant|>` literally. " + answer.replaceAll("\n", " ");
  it.each([
    ["ordinary prose", `<|assistant|>${answer}`, answer],
    [
      "a lone backtick",
      `<|assistant|>${answer.slice(0, 8_000)} a lone \` tick ${answer.slice(8_000)}`,
      `${answer.slice(0, 8_000)} a lone \` tick ${answer.slice(8_000)}`,
    ],
    ["tilde-dense prose", `<|assistant|>${tildeAnswer}`, tildeAnswer],
    ["a quoted token", quotedAnswer, quotedAnswer],
  ])("scans a bounded prefix with %s", (_name, source, expected) => {
    expect(source.length).toBeGreaterThan(16_000);
    const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
    const probe = vi.spyOn(RegExp.prototype, "test");
    let tokenScanCharacters = 0;
    try {
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
      probe.mock.calls.forEach(([value], index) => {
        const receiver = probe.mock.contexts[index];
        if (receiver instanceof RegExp && receiver.source.startsWith("<[|｜]")) {
          tokenScanCharacters += value.length;
        }
      });
    } finally {
      probe.mockRestore();
    }
    expect(projection.text).toBe(expected);
    expect(tokenScanCharacters).toBeGreaterThan(0);
    expect(tokenScanCharacters).toBeLessThan(source.length * 4);
  });

  it("matches the batch transform when a standalone definition revokes a kept token", () => {
    const source = "[a `<|assistant|>`]: /url";
    const batch = stripModelSpecialTokens(source);
    expect(batch).toBe("[a ``]: /url");
    for (const chunkSize of chunkSizes) {
      const result = streamSource(source, chunkSize);
      expect(result.text, `definition label text at ${chunkSize} chars`).toBe(batch);
      expect(result.delivered, `definition label deltas at ${chunkSize} chars`).toBe(batch);
    }
  });

  it("matches the batch transform when an escaped bracket precedes a definition token", () => {
    const source = "[a \\] `<|assistant|>`]: /url";
    const batch = stripModelSpecialTokens(source);
    expect(batch).toBe("[a \\] ``]: /url");
    const projection = createTextProjection([modelSpecialTokensTextFilter]);
    projection.append("[a \\] `<|assistant|>`");
    expect(projection.append("]: /url").text).toBe(batch);
  });

  it("restores a stripped token when a definition suffix invalidates it", () => {
    const source = "![a `<|assistant|>`][id]\n\n[id]: /url x";
    const batch = stripModelSpecialTokens(source);
    expect(batch).toBe("![a `<|assistant|>`][id]\n\n[id]: /url x");
    for (const chunkSize of chunkSizes) {
      const result = streamSource(source, chunkSize);
      expect(result.text, `restored token text at ${chunkSize} chars`).toBe(batch);
      expect(result.delivered, `restored token deltas at ${chunkSize} chars`).toBe(batch);
    }
  });
});
