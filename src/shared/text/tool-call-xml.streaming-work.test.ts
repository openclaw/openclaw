import { describe, expect, it, vi } from "vitest";
import * as codeRegions from "./code-regions.js";
import { expectPrefixParity, regexWork, streamChunks } from "./streaming.test-support.js";
import { createTextProjection } from "./text-projection.js";
import { stripToolCallXmlTags, toolCallXmlTextFilter } from "./tool-call-xml.js";

const CHUNK = 4;
const call = '<tool_call>{"path":"a.ts"}</tool_call>';
const xmlFilter = (streaming = true) =>
  toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, streaming);

function observeMarkdownOwnership() {
  const spies = [
    vi.spyOn(codeRegions, "findCodeRegions"),
    vi.spyOn(codeRegions, "findCodeOwnership"),
  ];
  return {
    characters: () =>
      spies.reduce(
        (total, spy) => total + spy.mock.calls.reduce((sum, [text]) => sum + text.length, 0),
        0,
      ),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

function streamXml(source: string, size = CHUNK) {
  return streamChunks(source, size, createTextProjection([xmlFilter()]));
}

const jsxAnswer = (sections: number) =>
  "```jsx\n<div><p>{items.length < 3 ? <b>Few</b> : <i>Many</i>}</p></div>\n```\n".repeat(sections);

/** An ordinary HTML answer whose line length periodically leaves "<p" at a delta edge. */
function htmlAnswer(size: number, lineBreak = true): string {
  const line = "<details><summary>Result</summary><p>ordinary text</p></details>";
  return `${line}${lineBreak ? "\n" : ""}`.repeat(Math.floor(size / (line.length + 1)));
}

describe("toolCallXmlTextFilter streamed projection work", () => {
  it.each([
    ["startsWith", 4],
    ["indexOf", 8],
    ["slice", 4],
  ] as const)("bounds %s work at partial tag boundaries", (method, multiplier) => {
    const source = htmlAnswer(48_000);
    const probe = vi.spyOn(String.prototype, method);
    let characters = 0;
    try {
      const streamed = streamXml(source);
      expect(streamed.text).toBe(source);
      expect(streamed.delivered).toBe(source);
      characters = probe.mock.calls.reduce((total, [first, end], index) => {
        if (method === "startsWith") {
          return total + (typeof first === "string" ? first.length : 0);
        }
        const value = probe.mock.contexts[index];
        const counted =
          method === "indexOf"
            ? first === "<"
            : first === 0 && typeof end === "number" && end > 1024;
        return total + (counted && typeof value === "string" ? value.length : 0);
      }, 0);
    } finally {
      probe.mockRestore();
    }
    expect(characters).toBeLessThan(source.length * multiplier);
  });

  const literalFence = "```text\n<think>literal code</think>\n```\nOrdinary prose follows.\n\n";
  it.each([
    ["JSX", jsxAnswer(20), CHUNK, false],
    ["multiline HTML", htmlAnswer(16_000), CHUNK, false],
    ["single-line HTML", htmlAnswer(16_000, false), CHUNK, false],
    [
      "a fenced tool-call example",
      `\`\`\`xml\n<tool_call>{"path":"a.ts"}</tool_call>\n\`\`\`\n\n${htmlAnswer(16_000)}`,
      98,
      true,
    ],
    [
      "an outer final tag before repeated fences",
      `<final>${literalFence.repeat(Math.ceil(22_000 / literalFence.length))}</final>`,
      98,
      true,
    ],
  ] as const)("bounds Markdown ownership work for %s", (_, source, size, protectedText) => {
    const work = observeMarkdownOwnership();
    try {
      const filter = xmlFilter();
      const projection = createTextProjection([filter]);
      let delivered = "";
      let parsedCharacters = 0;
      for (let offset = 0; offset < source.length; offset += size) {
        const expected = protectedText ? filter.transform(source.slice(0, offset + size)) : null;
        const before = work.characters();
        const result = projection.append(source.slice(offset, offset + size));
        parsedCharacters += work.characters() - before;
        delivered = result.delta === null ? result.text : delivered + result.delta;
        if (expected !== null) {
          expect(result.text).toBe(expected);
          expect(delivered).toBe(expected);
        }
      }
      expect(projection.text).toBe(source);
      expect(delivered).toBe(source);
      if (protectedText) {
        expect(parsedCharacters).toBeGreaterThan(0);
      }
      expect(parsedCharacters).toBeLessThan(source.length * 2);
    } finally {
      work.restore();
    }
  });

  it("matches canonical XML projection at every chunk boundary", () => {
    const sources = [
      ...["", " ", "\t"].map((suffix) => `    <${suffix}`),
      "\t<",
      "- item\n\n      <",
      ...["    ", "\t", " \t", "\n\n    ", "text\n\n    "].map((prefix) => `${prefix}<p`),
      "```\n<tool_call>\n```\n\n<p>x</p>\n\n```\n<tool_call>{}</tool_call>\n```",
      ...["- item\n\n      ", "- item\n    ", ">     ", "\r\n    ", "text\r\r    "].map(
        (prefix) => `${prefix}<p`,
      ),
      "    <pre",
      ...["    ", "\t"].map((indent) => indent + call),
      "text\n\n    " + call + "\n\nDone.",
      "```html\n<p",
      "```xml\n" + call + "\n```\n\n<p",
      "~~~xml\n" + call + "\n~~~",
      " ```xml\n" + call + "\n ```",
      "```bad `info\n" + call + "\n```",
      "- item\n\n  ```xml\n" + call + "\n  ```",
      "> ```xml\n> " + call + "\n> ```",
      "`<p`",
      "`" + call + "`",
      "`` `<p ``",
      "![x `" + call + "`][id]\n\n[id]: /url",
      "<pre>\n    " + call + "\n</pre>",
      "<div>\n```\n" + call + "\n```\n</div>",
      "<!--\n```\n" + call + "\n```\n-->",
      "<script>\n" + call + "\n</script>",
      "<details><summary>Result</summary><p>text</p></details>",
      ...["", "p", "pre", "tool_call", "function", "/t", "parameter "].map(
        (tag) => `Before <${tag}`,
      ),
      "<\n\na\n\n<",
      "<\n\na",
      "<`</f\n\n<```",
      '<tool_call>{"path":"a.ts"}</tool_call><parameter ',
      "<parameter>value</parameter>",
      '<function name="read"><parameter name="path">a.ts</parameter></function>',
      "<tool_call>\n" + call + "\n</tool_call>",
      "&lt;tool_call&gt; &amp; <p>x</p>",
      "```xml\r\n" + call + "\r\n```\r\n<p",
      'a <p b <tool_call>{"x":1}</tool_call> done',
      "<p<p",
      "<p<tool_call>{}</tool_call>",
      "<p<function",
      "<p<pre>text</pre>",
      "`<p`<p<tool_call>{}</tool_call>",
      "<tool_call>{}</tool_call><p<p",
      '[x]: / "title\n```\n<p\n"',
      "[x]: / 'title\n```\n<p\n'",
      "[x]: / (title\n```\n<p\n)",
    ].flatMap((source) => ["", "\n", "\r\n", "\n\n"].map((suffix) => source + suffix));

    for (const streaming of [false, true]) {
      const filter = xmlFilter(streaming);
      for (const source of sources) {
        expectPrefixParity(source, () => createTextProjection([filter]), filter.transform);
      }
    }
  });

  it.each([
    ["split name", `Before.\n${call}\nAfter.`, 1],
    ["ordinary markup", `${jsxAnswer(2)}\n${call}\nAfter.`, CHUNK],
    // Backticks in a fence info string cannot protect its payload.
    ["malformed fence", `\`\`\`jsx \`code\`\n${call}\nDone.`, CHUNK],
  ] as const)("strips a call after %s", (label, source, size) => {
    const projection = streamXml(source, size);
    expect(projection.text).toBe(stripToolCallXmlTags(source));
    if (label === "split name") {
      expect(projection.text).toBe("Before.\n\nAfter.");
    }
    expect(projection.text).not.toContain(call);
    expect(projection.text).not.toContain('{"path":"a.ts"}');
    expect(projection.deltas.join("")).not.toContain('{"path":"a.ts"}');
  });
});

it("bounds work after unfenced XML while continuing the visible reply", () => {
  const lead =
    'Here is the call:\n<function_calls><invoke name="read"><parameter name="path">a.md</parameter></invoke></function_calls>\n';
  const source = lead + "The next step keeps the visible answer moving.\n".repeat(200);
  const filter = xmlFilter();
  const projection = createTextProjection([filter]);
  const testedCharacters = regexWork(() => streamChunks(source, CHUNK, projection));
  expect(projection.text).toBe(filter.transform(source));
  expect(projection.text).toContain("The next step");
  expect(projection.text).not.toContain("<invoke");
  // Includes bounded Markdown tail checks, but never a growing whole-reply scan per delta.
  expect(testedCharacters).toBeLessThan(source.length * 64);
});
