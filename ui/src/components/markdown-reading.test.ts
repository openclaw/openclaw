import { expect, it } from "vitest";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const repeatedPaths =
  "src/a.ts:2 and `src/a.ts:9`\n\n- [Again](src/a.ts:12)\n- src/b.ts and src/a.ts";

function fileReferences(html: string) {
  return [...htmlFragment(html).querySelectorAll<HTMLAnchorElement>(".markdown-file-link")].map(
    (link) => [
      link.dataset.filePath,
      link.dataset.fileLine,
      link.classList.contains("markdown-file-link--repeat"),
      link.getAttribute("role"),
      link.getAttribute("tabindex"),
    ],
  );
}

it("shows one file glyph per message while retaining each reference's action and line", () => {
  expect(fileReferences(toSanitizedMarkdownHtml(repeatedPaths, { fileLinks: true }))).toEqual([
    ["src/a.ts", "2", false, "button", "0"],
    ["src/a.ts", "9", true, "button", "0"],
    ["src/a.ts", "12", true, "button", "0"],
    ["src/b.ts", undefined, false, "button", "0"],
    ["src/a.ts", undefined, true, "button", "0"],
  ]);
  expect(fileReferences(toSanitizedMarkdownHtml("src/a.ts", { fileLinks: true }))[0]?.[2]).toBe(
    false,
  );
  expect(
    fileReferences(
      toSanitizedMarkdownHtml(repeatedPaths, { fileLinks: true, mode: "document" }),
    ).map((reference) => reference[2]),
  ).toEqual([false, false, false, false, false]);
});

it("retains the first file glyph across streaming prefix promotion and resets on replacement", () => {
  const key = "reading-file-glyphs";
  for (const [source, repeats] of [
    ["Intro\n\nsrc/a.ts", [false]],
    ["Intro\n\nsrc/a.ts more", [false]],
    ["src/a.ts\n\n", [false]],
    ["src/a.ts\n\nsrc/a.ts", [false, true]],
    ["src/a.ts\n\nsrc/a.ts\n\n", [false, true]],
  ] as const) {
    const html = toStreamingMarkdownParts(source, { fileLinks: true }, key).join("");
    expect(fileReferences(html).map((reference) => reference[2])).toEqual(repeats);
  }
  const replacement = toStreamingMarkdownParts("Again src/a.ts", { fileLinks: true }, key).join("");
  expect(fileReferences(replacement).map((reference) => reference[2])).toEqual([false]);
});

it.each([
  ["**Heading**", true],
  ["**Review `src/a.ts` and [the guide](https://example.com)**<br>", true],
  ["**Heading**  \n", true],
  ["**First** **Second**", false],
  ["Prefix **Heading**", false],
  ["**Heading** trailing", false],
  ["**Heading**\nFollowing prose", false],
  ["**Heading**<br>Following prose", false],
  ["**Heading**<br><br>", false],
])("gives heading rhythm only to standalone bold paragraphs: %s", (source, lead) => {
  for (const html of [toSanitizedMarkdownHtml(source), toStreamingMarkdownParts(source).join("")]) {
    expect(htmlFragment(html).querySelector("p")?.classList.contains("markdown-lead")).toBe(lead);
  }
  expect(
    htmlFragment(toSanitizedMarkdownHtml(source, { mode: "document" })).querySelector(
      ".markdown-lead",
    ),
  ).toBeNull();
});
