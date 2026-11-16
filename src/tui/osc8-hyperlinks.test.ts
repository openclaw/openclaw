import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { addOsc8Hyperlinks, extractUrls } from "./osc8-hyperlinks.js";

const link = (url: string, text = url) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

const pathUrl = "https://example.com/path";
const ipv6 = "http://[::1]:8080/path";
const wikipedia = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
const query = "https://example.com/v1.0/URL_(disambiguation)?a=1&b=2#section";

describe("extractUrls", () => {
  it.each([
    ["sentence punctuation", `Visit ${pathUrl}.`, [pathUrl]],
    ["GFM punctuation", `Visit ${pathUrl}.?!`, [pathUrl]],
    ["bidi isolate", `مرحبا ${pathUrl}\u2069`, [pathUrl]],
    ["bidi mark", `مرحبا ${pathUrl}\u200f`, [pathUrl]],
    ["markdown", `[Click here](${pathUrl})`, [pathUrl]],
    ["authored suffix", `[Click here](${pathUrl}.)`, [`${pathUrl}.`]],
    ["angle brackets and title", `[Click here](<${pathUrl}> "Example Title")`, [pathUrl]],
    [
      "rejected destination label",
      "[https://label.test](https://.) https://bare.test",
      ["https://bare.test"],
    ],
    ["no URLs", "No links here", []],
    ["IPv6", ipv6, [ipv6]],
    ["markdown parentheses", `[Wikipedia](${wikipedia})`, [wikipedia]],
    ["balanced parentheses and query", `Visit ${query}.`, [query]],
    ["incomplete destination", "[broken](https://)", []],
    ["invalid markdown authority", "[broken](https://.)", []],
    ["invalid bare authority", "https://.", []],
    ["missing authority", "https:///path", []],
    ["unmatched parenthesis", `(see ${pathUrl}).`, [pathUrl]],
  ] satisfies [string, string, string[]][])("extracts %s", (_name, markdown, expected) => {
    expect([...extractUrls(markdown)]).toStrictEqual(expected);
  });
  it("keeps authored destinations before bare URLs in first-seen order", () => {
    const md =
      "https://api.example.com [Docs](https://docs.example.com) " +
      "[Guide](https://guide.example.com) [Docs again](https://docs.example.com)";
    expect([...extractUrls(md)]).toEqual([
      "https://docs.example.com",
      "https://guide.example.com",
      "https://api.example.com",
    ]);
  });
});

describe("addOsc8Hyperlinks", () => {
  it.each([
    { name: "BEL", params: "", terminator: "\x07" },
    { name: "ST with link identity", params: "id=docs", terminator: "\x1b\\" },
  ])("preserves authored spans alongside unlinked URLs ($name)", ({ params, terminator }) => {
    const label = "https://example.test/label";
    const target = "https://example.test/destination";
    const bare = "https://example.test/bare";
    const prefix = "See ";
    const authored = `\x1b]8;${params};${target}${terminator}\x1b[32m${label}\x1b[0m\x1b]8;;${terminator}`;
    const line = `${prefix}${authored} then ${bare}`;

    const [rendered] = addOsc8Hyperlinks([line], new Set([target, bare]));

    expect(rendered).toContain(authored);
    expect(getOsc8LinkAtColumn(rendered!, prefix.length)).toBe(target);
    expect(getOsc8LinkAtColumn(rendered!, prefix.length + label.length)).toBeUndefined();
    expect(getOsc8LinkAtColumn(rendered!, prefix.length + label.length + " then ".length)).toBe(
      bare,
    );
  });

  it.each([
    ["empty URL set", ["Hello world", "No links here"], []],
    ["no URL text", ["Just some text", "No URLs here"], ["https://example.com"]],
    ["partial domain", ["https://", "example.org"], ["https://example.com"]],
    ["longer token", ["https://", "example.com/pathology"], [pathUrl]],
    ["punctuation-only body", ["https://."], ["https://."]],
  ] satisfies [string, string[], string[]][])("leaves %s unchanged", (_name, lines, urls) => {
    expect(addOsc8Hyperlinks(lines, new Set(urls))).toEqual(lines);
  });

  it.each([
    { prefix: "Visit ", url: "https://example.com", suffix: " for info" },
    { prefix: "🦞 東京 ", url: "https://example.com/😀/e\u0301", suffix: " 🧑‍💻" },
    { prefix: "\ud800 ", url: "https://example.com/\udfff", suffix: " \udc00" },
  ])("wraps a single-line URL with OSC 8 ($url)", ({ prefix, url, suffix }) => {
    expect(addOsc8Hyperlinks([`${prefix}${url}${suffix}`], new Set([url]))).toEqual([
      `${prefix}${link(url)}${suffix}`,
    ]);
  });

  it.each([".", ".?!"])(
    "keeps trailing GFM punctuation %s outside terminal hyperlink targets",
    (punctuation) => {
      const url = "https://example.com/path";
      const line = `Visit ${url}${punctuation}`;

      expect(addOsc8Hyperlinks([line], extractUrls(line))).toEqual([
        `Visit ${link(url)}${punctuation}`,
      ]);
    },
  );

  it("preserves punctuation explicitly authored in markdown hyperlink targets", () => {
    const url = "https://example.com/path.";
    const line = `Docs (${url})`;

    expect(addOsc8Hyperlinks([line], extractUrls(`[Docs](${url})`))).toEqual([
      `Docs (${link(url)})`,
    ]);
  });

  it("keeps authored and bare hyperlink occurrences distinct before punctuation", () => {
    const punctuation = ".";
    const bareUrl = "https://example.com/path";
    const authoredUrl = `${bareUrl}${punctuation}`;
    const markdown = `[Docs](${authoredUrl}) and ${bareUrl}${punctuation}`;
    const rendered = `Docs (${authoredUrl}) and ${bareUrl}${punctuation}`;

    expect(addOsc8Hyperlinks([rendered], extractUrls(markdown))).toEqual([
      `Docs (${link(authoredUrl)}) and ${link(bareUrl)}${punctuation}`,
    ]);
  });

  it("keeps bidi isolation outside the exact OSC 8 target", () => {
    const url = "https://example.com/path";
    expect(addOsc8Hyperlinks([`\u2067مرحبا ${url}\u2069`], new Set([url]))).toEqual([
      `\u2067مرحبا ${link(url)}\u2069`,
    ]);
  });

  it("keeps a whole code point when a wrapped continuation matches only its high surrogate", () => {
    const prefix = "https://example.com/";
    const url = `${prefix}😀/path`;

    expect(addOsc8Hyperlinks([prefix, "😁 next"], new Set([url]))).toEqual([
      link(url, prefix),
      `${link(url, "😁")} next`,
    ]);
  });

  it("wraps a URL with a bracketed IPv6 authority", () => {
    const url = "http://[::1]:8080/path";
    expect(addOsc8Hyperlinks([url], new Set([url]))).toEqual([link(url)]);
  });

  it("wraps a URL broken immediately after its scheme", () => {
    const fullUrl = "https://example.com/path";
    const result = addOsc8Hyperlinks(["https://", "example.com/path"], new Set([fullUrl]));

    expect(result).toEqual([link(fullUrl, "https://"), link(fullUrl, "example.com/path")]);
  });

  it("handles URL with ANSI styling codes", () => {
    const url = "https://example.com";
    const styledLine = `\x1b[32m${url}\x1b[0m`;
    const result = addOsc8Hyperlinks([styledLine], new Set([url]));

    expect(result[0]).toContain("\x1b[32m");
    expect(result[0]).toContain("\x1b[0m");
    expect(result[0]).toContain(`\x1b]8;;${url}\x07`);
    expect(result[0]).toContain(`\x1b]8;;\x07`);
  });

  it.each([
    ["longest prefix", ["a", "ab"], "", "ab"],
    ["exact match before longer prefix", ["ab", "a"], "a", "a"],
    ["first equal-length prefix", ["ab", "aa"], "a", "ab"],
  ] as const)("resolves a rendered fragment by %s", (_name, known, fragment, expected) => {
    const url = (suffix: string) => `https://example.test/${suffix}`;
    expect(addOsc8Hyperlinks([url(fragment)], new Set(known.map(url)))).toEqual([
      link(url(expected), url(fragment)),
    ]);
  });

  it("wraps URLs with parentheses in markdown rendered text", () => {
    const url = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
    const line = `Wikipedia (${url})`;
    const result = addOsc8Hyperlinks([line], new Set([url]));
    expect(result[0]).toBe(`Wikipedia (${link(url)})`);
  });

  it("does not resolve an incomplete URL to another known URL", () => {
    const url = "https://example.com";
    const result = addOsc8Hyperlinks(["broken (https://)", url], new Set([url]));
    expect(result[0]).toBe("broken (https://)");
    expect(result[1]).toContain(link(url));
  });

  it("handles URL split across three lines", () => {
    const fullUrl = "https://example.com/a/very/long/path/that/keeps/going/and/going";
    const lines = ["https://example.com/a/very/lon", "g/path/that/keeps/going/and/g", "oing"];
    const result = addOsc8Hyperlinks(lines, new Set([fullUrl]));

    for (const line of result) {
      expect(line).toContain(`\x1b]8;;${fullUrl}\x07`);
      expect(line).toContain(`\x1b]8;;\x07`);
    }
  });
});
