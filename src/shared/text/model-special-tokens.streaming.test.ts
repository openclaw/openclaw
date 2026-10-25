import { describe, expect, it, vi } from "vitest";
import {
  assistantVisibleTextFilters,
  sanitizeAssistantVisibleTextWithProfile,
} from "./assistant-visible-text.js";
import { modelSpecialTokensTextFilter } from "./model-special-tokens.js";
import { applyTextFilters, createTextProjection, type TextFilter } from "./text-projection.js";

function streamSource(
  source: string,
  chunkSize: number,
  filters: readonly TextFilter[] = [modelSpecialTokensTextFilter],
) {
  const projection = createTextProjection(filters);
  let delivered = "";
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    const { text, delta } = projection.append(source.slice(offset, offset + chunkSize));
    delivered = delta === null ? text : delivered + delta;
    if (chunkSize === 1) {
      expect(text).toBe(applyTextFilters(source.slice(0, offset + 1), filters));
    }
  }
  return { text: projection.text, delivered };
}

function expectStream(source: string, expected: string, delivery = false) {
  const filters = delivery
    ? assistantVisibleTextFilters("delivery", true)
    : [modelSpecialTokensTextFilter];
  for (const size of chunkSizes) {
    const result = streamSource(source, size, filters);
    expect(result.text, `text at ${size} chars`).toBe(expected);
    expect(result.delivered, `deltas at ${size} chars`).toBe(expected);
  }
}

const chunkSizes = [1, 2, 3, 4, 5, 7, 64];

const sources: Array<[string, string?]> = [
  ["<|assistant|>Hello there."],
  ["Hello<|assistant|>world"],
  ["first<|user|><|assistant|>second"],
  ["Hello<|assistant|>"],
  ["Hello<|assistant|>World"],
  ["<｜begin▁of▁sentence｜>Hello there"],
  ["```text\n<|assistant|>\n```\nVisible text."],
  ["~~~text\n<|assistant|>\n~~~\nVisible text."],
  ["`<|assistant|>` stays visible."],
  ["Use `<|assistant|> tokens` carefully."],
  ["![a `<|assistant|>`][id]\n\n[id]: /url\n", "![a ``][id]\n\n[id]: /url\n"],
  ["![a `<|assistant|>`](/img.png)\n"],
  ['![a](/u "ti `<|assistant|>`tle")\n'],
  ["![a `<|assistant|>`][id]\n\n[other]: /url\n"],
  ["![a `<|assistant|>`]\n\n[a `<|assistant|>`]: /url\n"],
  ["![a `<|assistant|>`][id]\n\n[id]:\n /url\n"],
  ["Use \\` and `<|assistant|> tokens` here."],
  ["`<|assistant|>``"],
  ["`<|assistant|>```"],
  ["head <|a<b|> tail"],
  ["Elm: use <| for application.\n\nLater: chain with |> instead."],
  ["𐐀<|assistant|>𐐁"],
  ["café<|assistant|>word"],
  ["Hello<|assistant|>."],
  ["<div>x</div>\n<|assistant|>done"],
  ["The gateway streams the reply without control tokens."],
  ["![a `<|assistant|>`][id]\n\n[id]: /url x", "![a `<|assistant|>`][id]\n\n[id]: /url x"],
  ['![a `<|assistant|>`][id]\n\n[id]: /url "t" x'],
  ["![a `<|assistant|>`][id]\n\n[id]:\n/url x"],
  ["![a `<|assistant|>`][]\n\n[a `<|assistant|>`]: /url x"],
  ["![a `<|assistant|>`]\n\n[a `<|assistant|>`]: /url x"],
  ["[a `<|assistant|>`]: /url", "[a ``]: /url"],
  ["[a `<|assistant|>`]: /url x"],
  ["hi\n\n[a `<|assistant|>`]: /url"],
  ["> [a `<|assistant|>`]: /url"],
  ["- [a `<|assistant|>`]: /url"],
  ["1. [a `<|assistant|>`]: /url"],
  ["> - [a `<|assistant|>`]: /url"],
  ['[a `<|assistant|>`]: /url "t'],
  ["[a `<|assistant|>`](url) stays visible."],
  ["[a `<|assistant|>`][missing] stays visible."],
  ["[a \\] `<|assistant|>`]: /url"],
];

describe("model special token streaming", () => {
  it.each(["\n", "\r\n", "\r"])(
    "restores code before an invalidated table delimiter with %j line endings",
    (newline) => {
      const prefix = ["`", "[tool:read] {}", "<|x|>", "` |", "---|"].join(newline);
      for (const filters of [
        [modelSpecialTokensTextFilter],
        assistantVisibleTextFilters("final-answer-delivery", true),
      ]) {
        const projection = createTextProjection(filters);
        expect(projection.append(prefix).text).not.toContain("<|x|>");
        expect(projection.append("x")).toEqual({ text: prefix + "x", delta: null });
      }
    },
  );

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
    expect(modelSpecialTokensTextFilter.transform(source)).toBe(expected);
    const check = (chunks: string[]) => {
      const projection = createTextProjection([modelSpecialTokensTextFilter]);
      let prefix = "";
      let delivered = "";
      for (const chunk of chunks) {
        prefix += chunk;
        const result = projection.append(chunk);
        delivered = result.delta === null ? result.text : delivered + result.delta;
        const batch = modelSpecialTokensTextFilter.transform(prefix);
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

  it.each(sources)("matches the batch transform for %j", (source, expected) => {
    const batch = modelSpecialTokensTextFilter.transform(source);
    if (expected !== undefined) {
      expect(batch).toBe(expected);
    }
    expectStream(source, batch);
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

  it("matches the batch delivery profile when a token becomes code-owned later", () => {
    const source = "Use `<|assistant|> tokens` carefully.";
    const batch = sanitizeAssistantVisibleTextWithProfile(source, "delivery", false);
    expectStream(source, batch, true);
  });

  it("matches the delivery profile when image completion revokes a kept token", () => {
    const source = "![a `<|assistant|>`](/img.png)";
    const batch = sanitizeAssistantVisibleTextWithProfile(source, "delivery", false);
    expect(batch).toBe("![a ``](/img.png)");
    expectStream(source, batch, true);
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

  it("matches the batch transform when an escaped bracket precedes a definition token", () => {
    const source = "[a \\] `<|assistant|>`]: /url";
    const batch = modelSpecialTokensTextFilter.transform(source);
    expect(batch).toBe("[a \\] ``]: /url");
    const projection = createTextProjection([modelSpecialTokensTextFilter]);
    projection.append("[a \\] `<|assistant|>`");
    expect(projection.append("]: /url").text).toBe(batch);
  });
});
