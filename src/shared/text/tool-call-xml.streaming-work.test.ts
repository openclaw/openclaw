import { describe, expect, it, vi } from "vitest";
import * as codeRegions from "./code-regions.js";
import { createTextProjection } from "./text-projection.js";
import { stripToolCallXmlTags, toolCallXmlTextFilter } from "./tool-call-xml.js";

const CHUNK = 4;

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

/** An ordinary frontend answer: fenced JSX with many tags, no tool-call markup. */
function jsxAnswer(sections: number): string {
  const parts: string[] = [];
  for (let index = 0; index < sections; index += 1) {
    parts.push(
      `Section ${index} renders the following component.`,
      "",
      "```jsx",
      `export function Card${index}({ title, items }) {`,
      "  return (",
      `    <section className="card card-${index}">`,
      "      <h2>{title}</h2>",
      "      <ul>",
      "        {items.map((item) => (",
      "          <li key={item.id}>{item.label}</li>",
      "        ))}",
      "      </ul>",
      `      {items.length < ${index + 3} ? <p>Few items</p> : <p>Many items</p>}`,
      "    </section>",
      "  );",
      "}",
      "```",
      "",
    );
  }
  return parts.join("\n");
}

/** An ordinary HTML answer whose line length periodically leaves "<p" at a delta edge. */
function htmlAnswer(size: number, lineBreak = true): string {
  const line = "<details><summary>Result</summary><p>ordinary text</p></details>";
  return `${line}${lineBreak ? "\n" : ""}`.repeat(Math.floor(size / (line.length + 1)));
}

describe("toolCallXmlTextFilter streamed projection work", () => {
  it("does not parse Markdown ownership for ordinary HTML/JSX markup", () => {
    const source = jsxAnswer(20);
    const work = observeMarkdownOwnership();
    try {
      const projection = createTextProjection([
        toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
      ]);
      for (let offset = 0; offset < source.length; offset += CHUNK) {
        projection.append(source.slice(offset, offset + CHUNK));
      }
      expect(projection.text).toBe(source);
      // Every `<div>`/`<li>`/`<p>` used to pay a whole-reply Markdown parse.
      expect(work.characters()).toBeLessThan(source.length * 2);
    } finally {
      work.restore();
    }
  });

  it.each([
    ["multiline", true],
    ["single line", false],
  ])("does not parse Markdown ownership for a partial ordinary tag prefix (%s)", (_, lineBreak) => {
    const source = htmlAnswer(16_000, lineBreak);
    const work = observeMarkdownOwnership();
    try {
      const projection = createTextProjection([
        toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
      ]);
      for (let offset = 0; offset < source.length; offset += CHUNK) {
        projection.append(source.slice(offset, offset + CHUNK));
      }
      expect(projection.text).toBe(source);
      // A trailing "<p" can still become <parameter>; resolving that ambiguity must
      // not reparse the whole Markdown document at every repeated tag boundary.
      expect(work.characters()).toBeLessThan(source.length * 2);
    } finally {
      work.restore();
    }
  });

  const literalFence = "```text\n<think>literal code</think>\n```\nOrdinary prose follows.\n\n";
  it.each([
    [
      "a fenced tool-call example",
      `\`\`\`xml\n<tool_call>{"path":"a.ts"}</tool_call>\n\`\`\`\n\n${htmlAnswer(16_000)}`,
    ],
    [
      "an outer final tag before repeated fences",
      `<final>${literalFence.repeat(Math.ceil(22_000 / literalFence.length))}</final>`,
    ],
  ])("keeps partial-prefix ownership work bounded after %s", (_, source) => {
    const work = observeMarkdownOwnership();
    try {
      const filter = toolCallXmlTextFilter(
        { stripFunctionResponseAfterPluralToolCalls: true },
        true,
      );
      const projection = createTextProjection([filter]);
      let delivered = "";
      let parsedCharacters = 0;
      for (let offset = 0; offset < source.length; offset += 98) {
        const expected = filter.transform(source.slice(0, offset + 98));
        const before = work.characters();
        const result = projection.append(source.slice(offset, offset + 98));
        parsedCharacters += work.characters() - before;
        delivered = result.delta === null ? result.text : delivered + result.delta;
        expect(result.text).toBe(expected);
        expect(delivered).toBe(expected);
      }
      expect(projection.text).toBe(source);
      expect(parsedCharacters).toBeGreaterThan(0);
      expect(parsedCharacters).toBeLessThan(source.length * 2);
    } finally {
      work.restore();
    }
  });

  it("matches canonical XML projection at every chunk boundary", () => {
    const call = '<tool_call>{"path":"a.ts"}</tool_call>';
    const sources = [
      "    <",
      "\t<",
      "- item\n\n      <",
      "    < ",
      "    <\t",
      "    <p",
      "\t<p",
      " \t<p",
      "\n\n    <p",
      "text\n\n    <p",
      "```\n<tool_call>\n```\n\n<p>x</p>\n\n```\n<tool_call>{}</tool_call>\n```",
      "- item\n\n      <p",
      "- item\n    <p",
      ">     <p",
      "    <pre",
      "    " + call,
      "\t" + call,
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
      "Before <",
      "Before <p",
      "Before <pre",
      "Before <tool_call",
      "Before <function",
      "Before </t",
      "Before <parameter ",
      '<tool_call>{"path":"a.ts"}</tool_call><parameter ',
      "<parameter>value</parameter>",
      '<function name="read"><parameter name="path">a.ts</parameter></function>',
      "<tool_call>\n" + call + "\n</tool_call>",
      "&lt;tool_call&gt; &amp; <p>x</p>",
      "\r\n    <p",
      "```xml\r\n" + call + "\r\n```\r\n<p",
      "text\r\r    <p",
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
      const filter = toolCallXmlTextFilter(
        { stripFunctionResponseAfterPluralToolCalls: true },
        streaming,
      );
      for (const source of sources) {
        // Compare retained state with a fresh canonical transform at each prefix.
        const expected = Array.from({ length: source.length + 1 }, (_, end) =>
          filter.transform(source.slice(0, end)),
        );
        const schedules = [
          ...Array.from({ length: source.length + 1 }, (_, split) => [split, source.length]),
          ...[1, 4].map((size) =>
            Array.from({ length: Math.ceil(source.length / size) }, (_, index) =>
              Math.min((index + 1) * size, source.length),
            ),
          ),
        ];
        for (const ends of schedules) {
          const projection = createTextProjection([filter]);
          let start = 0;
          let previous = "";
          for (const end of ends) {
            const result = projection.append(source.slice(start, end));
            expect(result.text, JSON.stringify({ source, streaming, start, end })).toBe(
              expected[end],
            );
            if (result.delta !== null) {
              expect(previous + result.delta).toBe(result.text);
            }
            previous = result.text;
            start = end;
          }
        }
      }
    }
  });

  it("still strips a tool-call tag whose name is split across deltas", () => {
    const call = '<tool_call>{"path":"a.ts"}</tool_call>';
    const source = `Before.\n${call}\nAfter.`;
    const projection = createTextProjection([
      toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
    ]);
    for (const char of source) {
      projection.append(char);
    }
    expect(projection.text).toBe(stripToolCallXmlTags(source));
    expect(projection.text).toBe("Before.\n\nAfter.");
  });

  it("preserves a quoted tool-call example inside fenced code", () => {
    const source = '```xml\n<tool_call>{"path":"a.ts"}</tool_call>\n```\n\nDone.';
    const projection = createTextProjection([
      toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
    ]);
    for (let offset = 0; offset < source.length; offset += 3) {
      projection.append(source.slice(offset, offset + 3));
    }
    expect(projection.text).toBe(source);
  });

  it("still strips a tool call that follows ordinary markup", () => {
    const call = '<tool_call>{"path":"a.ts"}</tool_call>';
    const source = `${jsxAnswer(2)}\n${call}\nAfter.`;
    const projection = createTextProjection([
      toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
    ]);
    for (let offset = 0; offset < source.length; offset += CHUNK) {
      projection.append(source.slice(offset, offset + CHUNK));
    }
    expect(projection.text).toBe(stripToolCallXmlTags(source));
    expect(projection.text).not.toContain('{"path":"a.ts"}');
  });

  it("still strips a tool call behind a malformed backtick fence", () => {
    const call = '<tool_call>{"path":"a.ts"}</tool_call>';
    // CommonMark forbids backticks in a backtick fence's info string, so this line
    // does not own a code block for the canonical resolver.
    const source = `\`\`\`jsx \`code\`\n${call}\nDone.`;
    const projection = createTextProjection([
      toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
    ]);
    const deltas: string[] = [];
    for (let offset = 0; offset < source.length; offset += CHUNK) {
      const result = projection.append(source.slice(offset, offset + CHUNK));
      deltas.push(result.delta ?? "");
    }
    expect(projection.text).not.toContain(call);
    expect(projection.text).not.toContain('{"path":"a.ts"}');
    expect(deltas.join("")).not.toContain('{"path":"a.ts"}');
  });
});

it("bounds work after unfenced XML while continuing the visible reply", () => {
  const lead =
    'Here is the call:\n<function_calls><invoke name="read"><parameter name="path">a.md</parameter></invoke></function_calls>\n';
  const source = lead + "The next step keeps the visible answer moving.\n".repeat(200);
  const filter = toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true);
  const projection = createTextProjection([filter]);
  let testedCharacters: number;
  const probe = vi.spyOn(RegExp.prototype, "test");
  try {
    for (let offset = 0; offset < source.length; offset += CHUNK) {
      projection.append(source.slice(offset, offset + CHUNK));
    }
  } finally {
    testedCharacters = probe.mock.calls.reduce(
      (total, [text]) => total + (typeof text === "string" ? text.length : 0),
      0,
    );
    probe.mockRestore();
  }
  expect(projection.text).toBe(filter.transform(source));
  expect(projection.text).toContain("The next step");
  expect(projection.text).not.toContain("<invoke");
  // Includes bounded Markdown tail checks, but never a growing whole-reply scan per delta.
  expect(testedCharacters).toBeLessThan(source.length * 64);
});
