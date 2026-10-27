import { expect, it, vi } from "vitest";
import { findCodeRegions } from "./code-regions.js";
import * as text from "./text-projection.js";

vi.mock("./code-regions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./code-regions.js")>();
  return { ...actual, findCodeRegions: vi.fn(actual.findCodeRegions) };
});

const project = (...filters: text.TextFilter[]) => text.createTextProjection(filters);
const expectUpdate = (actual: text.TextProjection, value: string, delta: string | null = value) =>
  expect(actual).toEqual({ text: value, delta });
const replaceFilter = (token: string, pattern: RegExp, replacement = ""): text.TextFilter => ({
  activationTokens: [token],
  transform: (value) => value.replace(pattern, replacement),
});
const checkpointFilter = (
  token: string,
  transform: (value: string) => string,
): text.TextFilter => ({
  activationTokens: [token],
  transform,
  checkpoint: (value, boundary) => ({
    text: transform(value),
    retainStart: boundary,
    retainedOutputStart: boundary,
  }),
});
function replay(filter: text.TextFilter, chunks: string[], expected: string, strict = false) {
  const projection = project(filter);
  let delivered = "";
  for (const chunk of chunks) {
    const result = projection.append(chunk);
    if (strict) {
      expect(result.delta).not.toBeNull();
    }
    delivered = result.delta === null ? result.text : delivered + result.delta;
    expect(delivered).toBe(result.text);
  }
  expect(projection.text).toBe(expected);
  return projection;
}

it("activates split markers, reprojects completed syntax, and replaces the source", () => {
  const projection = project(replaceFilter("<private>", /<private>[\s\S]*?<\/private>/gi));
  expectUpdate(projection.append("Before <PRI"), "Before <PRI");
  expectUpdate(projection.append("VATE>secret"), "Before <PRIVATE>secret", "VATE>secret");
  expectUpdate(projection.append("</PRIVATE>after"), "Before after", null);
  expectUpdate(projection.append("."), "Before after.", ".");
  expectUpdate(projection.replace("Fresh "), "Fresh ", null);
  expectUpdate(projection.append("reply"), "Fresh reply", "reply");
  expect(projection).toMatchObject({ source: "Fresh reply", text: "Fresh reply" });
});

it("rechecks downstream activation when a preceding filter joins a marker", () => {
  const filters: text.TextFilter[] = [
    replaceFilter("<cut>", /<cut>.*?<\/cut>/g),
    replaceFilter("BEGIN", /BEGIN.*?END/g),
  ];
  const projection = project(...filters);
  projection.append("Before BE<cut>hidden");
  expectUpdate(projection.append("</cut>GIN private ENDafter"), "Before after", null);
  expect(text.applyTextFilters(projection.source, filters)).toBe("Before after");
});

it("preserves an append when downstream filtering cancels an intermediate correction", () => {
  const projection = project(
    replaceFilter("<cut>", /<cut>.*?<\/cut>/g),
    replaceFilter("<cut>", /<cut>.*/g),
  );
  expectUpdate(projection.append("Ready <cut>hidden"), "Ready ");
  expectUpdate(projection.append("</cut>reply"), "Ready reply", "reply");
  expectUpdate(projection.replace("Ready reply"), "Ready reply", null);
});

it("keeps settled equal-length rewrites when later checkpoint windows are unchanged", () => {
  const projection = project(checkpointFilter("@", (value) => value.replaceAll("@", "!")));
  expectUpdate(projection.append("@first\n"), "!first\n");
  expectUpdate(projection.append("second\n"), "!first\nsecond\n", "second\n");
  expectUpdate(projection.append("third\n"), "!first\nsecond\nthird\n", "third\n");
  expectUpdate(projection.replace("fresh\n"), "fresh\n", null);
  expectUpdate(projection.append("@next\n"), "fresh\n!next\n", "!next\n");
});

it("restores a transformed prefix through chained checkpoints", () => {
  const projection = project(
    checkpointFilter("secret", (value) => value),
    {
      activationTokens: ["secret"],
      transform: (value) => (value.endsWith("!") ? value : value.replace("secret ", "")),
    },
    checkpointFilter("A", (value) => value.replaceAll("A", "@")),
  );
  expectUpdate(projection.append("secret A\n\nB\n\nC"), "@\n\nB\n\nC");
  expectUpdate(projection.append("!"), "secret @\n\nB\n\nC!", null);
  expectUpdate(projection.append(" tail"), "@\n\nB\n\nC! tail", null);
});

it.each(["none", "start", "both"] as const)("trims %s across whitespace boundaries", (mode) => {
  const filter = text.trimTextFilter(mode);
  const projection = project(filter);
  let source = "";
  let delivered = "";
  for (const delta of [" \r", "\n\u00a0", " A ", "\t", "B\r", "\n", " C", "  "]) {
    source += delta;
    const result = projection.append(delta);
    const expected =
      mode === "both" ? source.trim() : mode === "start" ? source.trimStart() : source;
    expectUpdate(result, expected, expected.slice(delivered.length));
    expect(projection.matchesTrimmedSource).toBe(expected === source.trim());
    delivered = expected;
  }
  expectUpdate(projection.replace(" \tReset \n"), filter.transform(" \tReset \n"), null);
  expect(projection.append("end").text).toBe(filter.transform(" \tReset \nend"));
});

it("distinguishes preserved indentation and equal-length rewrites from trimmed source", () => {
  const projection = project(
    replaceFilter("swap", /swap/, "edit"),
    text.trimTextFilter("both", { preserveCodeIndentation: true }),
  );
  for (const source of ["\u00a0plain \n", "    code\n", " swap ", "\t\n"]) {
    projection.replace(source);
    expect(projection.matchesTrimmedSource).toBe(projection.text === source.trim());
    projection.append(" tail");
    expect(projection.matchesTrimmedSource).toBe(projection.text === `${source} tail`.trim());
  }
  const padding = project(replaceFilter("\n", /^\n/), text.trimTextFilter("both"));
  padding.append("\nSame ");
  expect(padding.matchesTrimmedSource).toBe(true);
});

it("removes only leading empty lines", () => {
  const projection = replay(
    text.leadingEmptyLinesTextFilter,
    [" \r", "\n\t\n", "  C", "\n D"],
    "  C\n D",
    true,
  );
  expectUpdate(projection.replace("\n  Reset"), "  Reset", null);
});
it.each([
  ["A\n\nA\n\n \n\nB", "A\n\n\n\nB"],
  ["\0\0\0\n\nA\n\nA\n\n`x`\0`y` `x`", "\0\0\0\n\nA\n\n`x`\0`y` `x`"],
  ["A\n\nA `x`", "A\n\nA `x`"],
  ["A\r\n\r\nA\r\n\r\nB", "A\r\n\r\nB"],
  ["A\r\nB\r\n\r\nA\r\nB", "A\r\nB"],
  ["A\r\n\r\nB", "A\r\n\r\nB"],
  ["```text\r\nA\r\n\r\nA\r\n```\r\n\r\nB\r\n\r\nB", "```text\r\nA\r\n\r\nA\r\n```\r\n\r\nB"],
  ["A\n\nA\n\n```\n", "A\n\n```\n"],
])("preserves canonical separators and whitespace %#", (source, expected) => {
  expect(text.duplicateParagraphTextFilter.transform(source)).toBe(expected);
  const partitions = [
    source.split(""),
    ...Array.from({ length: source.length + 1 }, (_, i) => [source.slice(0, i), source.slice(i)]),
  ];
  for (const chunks of partitions) {
    replay(text.duplicateParagraphTextFilter, chunks, expected);
  }
});

it.each([
  ["A\n\n\nB\n\nB", "A\n\nB", " changes", "A\n\n\nB\n\nB changes", null],
  ["A\n\nA", "A", " B\n\nA B", "A\n\nA B", "\n\nA B"],
] as const)(
  "reconciles diverging provisional duplicates %#",
  (initial, first, suffix, expected, delta) => {
    const projection = project(text.duplicateParagraphTextFilter);
    expectUpdate(projection.append(initial), first);
    expectUpdate(projection.append(suffix), expected, delta);
    expectUpdate(projection.replace("  New\n\nNew"), "New", null);
    expectUpdate(projection.append("\n\nLast "), "New\n\nLast", "\n\nLast");
    expectUpdate(projection.append("word"), "New\n\nLast word", " word");
  },
);

it("keeps code-bearing continuation appends on the incremental suffix path", () => {
  const parser = vi.mocked(findCodeRegions);
  parser.mockClear();
  const code = "```text\ninside\n\ninside\n```";
  const source = `${code}\n\nrepeat\n\nrepeat\n\ntail`;
  const projection = project(text.duplicateParagraphTextFilter);
  expect(projection.append(source).text).toBe(`${code}\n\nrepeat\n\ntail`);
  const initialParses = parser.mock.calls.length;
  expect(initialParses).toBeGreaterThan(0);

  for (let index = 0; index < 256; index++) {
    const delta = `-${index}`;
    expect(projection.append(delta).delta).toBe(delta);
  }
  expect(parser).toHaveBeenCalledTimes(initialParses);
  expect(projection.text).toBe(text.duplicateParagraphTextFilter.transform(projection.source));
});
