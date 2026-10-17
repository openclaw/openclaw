import { describe, expect, it, vi } from "vitest";
import * as codeRegions from "./code-regions.js";
import { createTextProjection } from "./text-projection.js";
import { stripToolCallXmlTags, toolCallXmlTextFilter } from "./tool-call-xml.js";

const CHUNK = 4;

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

describe("toolCallXmlTextFilter streamed projection work", () => {
  it("does not parse Markdown ownership for ordinary HTML/JSX markup", () => {
    const source = jsxAnswer(20);
    const regions = vi.spyOn(codeRegions, "findCodeRegions");
    try {
      const projection = createTextProjection([
        toolCallXmlTextFilter({ stripFunctionResponseAfterPluralToolCalls: true }, true),
      ]);
      for (let offset = 0; offset < source.length; offset += CHUNK) {
        projection.append(source.slice(offset, offset + CHUNK));
      }
      expect(projection.text).toBe(source);
      // Every `<div>`/`<li>`/`<p>` used to pay a whole-reply Markdown parse.
      const parsedCharacters = regions.mock.calls.reduce(
        (total, [parsed]) => total + parsed.length,
        0,
      );
      expect(parsedCharacters).toBeLessThan(source.length * 2);
    } finally {
      regions.mockRestore();
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
