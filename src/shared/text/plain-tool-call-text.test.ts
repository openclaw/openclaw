import { afterEach, expect, it, vi } from "vitest";
import * as toolCallRepair from "../../../packages/tool-call-repair/src/index.js";
import { assistantVisibleTextFilters, plainToolCallTextFilter } from "./assistant-visible-text.js";
import * as codeRegions from "./code-regions.js";
import { createTextProjection } from "./text-projection.js";

afterEach(() => vi.restoreAllMocks());

it.each([
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
])("matches the canonical strip while streaming %#", (source) => {
  for (const chunkSize of [1, 3, 7]) {
    const projection = createTextProjection([plainToolCallTextFilter]);
    let accumulated = "";
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      accumulated += source.slice(offset, offset + chunkSize);
      projection.append(source.slice(offset, offset + chunkSize));
      expect(projection.text).toBe(
        toolCallRepair.stripPlainTextToolCallBlocks(accumulated, {
          resolveProtectedRanges: codeRegions.findCodeRegions,
        }),
      );
    }
  }
});
it.each([
  null,
  '```json\n{"a":{"b":1}}\n```',
  '```text\n[tool:read] {"path":"a.ts"}\n```',
  '```text\n[tool:read] {"path":"a.ts"}',
])("bounds sanitizer work in token-sized deltas %#", (example) => {
  const sentence = "Ordinary sentence with words and periods.";
  const source =
    example === null
      ? Array.from({ length: 600 }, (_, i) => `[${i + 1}] ${sentence}\n`).join("")
      : `${example}\n\n${"An ordinary explanation continues here.\n".repeat(128)}`;
  const spies = [
    vi.spyOn(toolCallRepair, "stripPlainTextToolCallBlocks"),
    ...(example === null ? [] : [vi.spyOn(codeRegions, "findCodeRegions")]),
  ];
  const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
  for (let offset = 0; offset < source.length; offset += 4) {
    projection.append(source.slice(offset, offset + 4));
  }
  expect(projection.text).toBe(source.trimEnd());
  const parsedCharacters = spies
    .flatMap((spy) => spy.mock.calls.map(([text]) => text))
    .reduce((n, text) => n + text.length, 0);
  expect(parsedCharacters).toBeLessThan(source.length * 8);
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
