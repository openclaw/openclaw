import { describe, expect, it, vi } from "vitest";
import * as toolCallRepair from "../../../packages/tool-call-repair/src/index.js";
import { assistantVisibleTextFilters, plainToolCallTextFilter } from "./assistant-visible-text.js";
import * as codeRegions from "./code-regions.js";
import { findCodeRegions } from "./code-regions.js";
import { createTextProjection } from "./text-projection.js";

const reference = (text: string) =>
  toolCallRepair.stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: findCodeRegions });

const samples = [
  '[tool:read] {}\n\n[outer [inner]\nmore\nlabel](/url "title\n`x\n[tool:read] {}\nx`")',
  '[tool:read] {}\n\n[id]: /url\r\n"title\r\nmore\r\n`x\r\n[tool:read] {}\r\nx`"',
  "[tool:read] {}\n\n[a\\]b\nmiddle\nrest]: /url\n\nAfter\n\n![example `x\n[tool:read] {}\nx`][a\\]b middle rest]",
  "[id]: /url\n\n[tool:read] {}\nIntro.\n\n![example `x\n[tool:read] {}\nx`][id]\n",
  "[a\\]b]: /url\n\n[tool:read] {}\nIntro.\n\n![example `x\n[tool:read] {}\nx`][a\\]b]\n",
  "![example `x\n[tool:read] {}\nx`][id]\n```text\nnext\n```\n[id]: /url",
  " ```text\n[tool:read] {}\n ```\n[tool:read] {}\nDone.",
  " ```text\nbody\r ```\r\n[tool:read] {}\nDone.",
  "See sources.\n[1] A cited claim.\n[2] Another cited claim.\n[12] A third one.\n",
  'Plain prose that mentions [read] {"path": "a.ts"} mid-line.\n',
  'Visible.\n[tool:read] {"path":"a.ts"}\nDone.\n',
  'Visible.\n[read]\n{"path": "a.ts"}\n[/read]\nDone.\n',
  'Visible.\n[read]\n{"path": "a.ts"}',
  '[tool:message] {"action":"send","message":"[tool:read] {\\"path\\":\\"/app/skills/meme-maker/SKILL.md\\"}"}\n',
  "[tool:read]\n<parameter=path>\nsrc/index.ts\n</parameter>\n</function>\n",
  'Fenced:\n\n```\n[tool:read] {"path":"a.ts"}\n```\n\nAfter.\n',
  '\n\n   [tool:read] {"path":"a.ts"}\n',
  '```\n[tool:read] {\n```\n[tool:exec] {"command":"ls"}\nDone.',
  "[tool:read]\n<PARAMETER=path>src/index.ts</PARAMETER>\n",
  "<FUNCTION=read></FUNCTION>\nDone.",
  'analysis to=read code {"path":"a.ts"}\nDone.',
  'Adjacent.\n[read]\n{"path": "a.ts"}\n[/read]\n[exec]\n{"command": "ls"}\n[/exec]\nEnd.\n',
  'Inline: `[tool:read] {"path":"a.ts"}`.\n',
  '```json\n{"value":1}\n',
  '~~~text\n[tool:read] {"path":"a.ts"}\n~~~\nAfter.',
  '```text\n[tool:read] {"path":"a.ts"}\n```\n[tool:exec] {"command":"ls"}\nDone.',
  "[tool:read] {}\n\n[/read]\nDone.",
  "[tool:read] {}\n\n[not-a-close]\nDone.",
  '[read]\n\n{ "path": "a.ts" }\n[/read]\nDone.',
  "[tool:read]<parameter=x>value</parameter>\n<parameter=y>next</parameter>\nDone.",
  "[tool:read]<parameter=x>value</parameter>\n<parameter=invalid value\nDone.",
  "```ts\nconst first = {};\n```\n[tool:read] {}\nDone.\n~~~ts\nconst last = {};\n~~~",
  "```text\r\n[tool:read] {}\r\n```\r\n[tool:read] {}\r\nDone.",
  "Before `example\n[tool:read] {}\nend`.\n[tool:read] {}\nDone.",
  "> ```text\n> [tool:read] {}\n> ```\n\n[tool:read] {}\nDone.",
  "Intro\nHeading\n===\n    [tool:read] {}\n\nDone.",
  "Intro\n\n[reference]:\n    /example\n\n[tool:read] {}\nDone.",
];

describe("plainToolCallTextFilter streamed projection", () => {
  it("extends protection when an indented code block grows after a whitespace chunk", () => {
    const chunks = ["    [tool:read] {}\n", "    ", "[tool:write] {}\n"];
    const source = chunks.join("");
    const projection = createTextProjection([plainToolCallTextFilter]);

    for (const chunk of chunks) {
      projection.append(chunk);
    }

    expect(projection.text).toBe(reference(source));
    expect(projection.text).toContain("[tool:read] {}");
    expect(projection.text).toContain("[tool:write] {}");
  });

  it("refreshes cached ranges when a list-owned fence grows", () => {
    const chunks = ["- ```text\n  [tool:read] {}", "\n  [tool:write] {}\n"];
    const source = chunks.join("");
    const projection = createTextProjection([plainToolCallTextFilter]);

    for (const chunk of chunks) {
      projection.append(chunk);
    }

    expect(projection.text).toBe(reference(source));
    expect(projection.text).toContain("  [tool:read] {}");
    expect(projection.text).toContain("  [tool:write] {}");
  });

  it("bounds plain-tool-call parse work for citation replies in token-sized deltas", () => {
    const source = [
      "Here is the summary.",
      ...Array.from(
        { length: 600 },
        (_value, index) => `[${index + 1}] Ordinary sentence with words and periods.`,
      ),
      "",
    ].join("\n");
    const strip = vi.spyOn(toolCallRepair, "stripPlainTextToolCallBlocks");
    try {
      const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
      expect(projection.text).toBe(source.trimEnd());
      // Count the canonical precheck too: ordinary citations no longer require Markdown parsing.
      const parsedCharacters = strip.mock.calls.reduce(
        (total, [parsed]) => total + parsed.length,
        0,
      );
      expect(parsedCharacters).toBeLessThan(source.length * 8);
    } finally {
      strip.mockRestore();
    }
  });

  it.each([
    ["fenced JSON", '```json\n{"name":"example","deps":{"demo":"1.0"}}\n```'],
    ["fenced tool call", '```text\n[tool:read] {"path":"a.ts"}\n```'],
    ["unterminated fence", '```text\n[tool:read] {"path":"a.ts"}'],
  ])("bounds sanitizer work after %s in token-sized deltas", (_name, example) => {
    const source = `${example}\n\n${"An ordinary explanation continues here.\n".repeat(128)}`;
    const strip = vi.spyOn(toolCallRepair, "stripPlainTextToolCallBlocks");
    const regions = vi.spyOn(codeRegions, "findCodeRegions");
    try {
      const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
      expect(projection.text).toBe(source.trimEnd());
      const parsedCharacters = [...strip.mock.calls, ...regions.mock.calls].reduce(
        (total, [parsed]) => total + parsed.length,
        0,
      );
      expect(parsedCharacters).toBeLessThan(source.length * 8);
    } finally {
      strip.mockRestore();
      regions.mockRestore();
    }
  });

  it("rechecks retired code markers after a source replacement", () => {
    const projection = createTextProjection([plainToolCallTextFilter]);
    const call = '[tool:read] {"path":"a.ts"}';
    const fenced = `\`\`\`text\n${call}\n\`\`\`\n`;
    expect(projection.append(fenced).text).toBe(fenced);
    expect(projection.replace(`${call}\nDone.`).text).toBe("Done.");
    expect(projection.replace(fenced).text).toBe(fenced);
    expect(projection.append(`${call}\nDone.`).text).toBe(`${fenced}Done.`);
  });

  it.each(samples)("matches the canonical strip while streaming %#", (source) => {
    for (const chunkSize of [1, 3, 7]) {
      const projection = createTextProjection([plainToolCallTextFilter]);
      let accumulated = "";
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        accumulated += source.slice(offset, offset + chunkSize);
        projection.append(source.slice(offset, offset + chunkSize));
        expect(projection.text).toBe(reference(accumulated));
      }
    }
  });
});
