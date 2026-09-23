// Verifies OSC8 hyperlink formatting for TUI terminal output.
import { getOsc8LinkAtColumn } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { addOsc8Hyperlinks, extractUrls } from "./osc8-hyperlinks.js";

describe("extractUrls", () => {
  it("extracts bare URLs", () => {
    const urls = extractUrls("Check out https://example.com for more info");
    expect([...urls]).toEqual(["https://example.com"]);
  });

  it.each([".", ",", ";", "!", "?", ":", "*", "_", "~", ".?!"])(
    "excludes trailing GFM punctuation %s from bare URLs",
    (punctuation) => {
      expect([...extractUrls(`Visit https://example.com/path${punctuation}`)]).toEqual([
        "https://example.com/path",
      ]);
    },
  );

  it("stops bare URLs before bidi formatting controls", () => {
    const url = "https://example.com/path";
    expect([...extractUrls(`مرحبا ${url}\u2069`)]).toEqual([url]);
    expect([...extractUrls(`مرحبا ${url}\u200f`)]).toEqual([url]);
  });

  it("extracts multiple bare URLs", () => {
    const urls = extractUrls("Visit https://foo.com and http://bar.com");
    expect(urls).toContain("https://foo.com");
    expect(urls).toContain("http://bar.com");
    expect(urls.size).toBe(2);
  });

  it.each(["", ".", "?", ";"])("preserves authored markdown href suffix %s", (suffix) => {
    const url = `https://example.com/path${suffix}`;
    expect([...extractUrls(`[Click here](${url})`)]).toEqual([url]);
  });

  it("extracts markdown links with angle brackets and title text", () => {
    const urls = extractUrls('[Click here](<https://example.com/path> "Example Title")');
    expect([...urls]).toEqual(["https://example.com/path"]);
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

  it("does not extract URL-shaped labels from rejected markdown destinations", () => {
    const md = "[https://label.test](https://.) https://bare.test";
    expect([...extractUrls(md)]).toEqual(["https://bare.test"]);
  });

  it("deduplicates URLs", () => {
    const md = "Visit https://example.com and [link](https://example.com)";
    const urls = extractUrls(md);
    expect([...urls]).toEqual(["https://example.com"]);
  });

  it("returns no URLs for text without URLs", () => {
    expect([...extractUrls("No links here")]).toStrictEqual([]);
  });

  it("handles URLs with query params and fragments", () => {
    const urls = extractUrls("https://example.com/path?q=1&r=2#section");
    expect([...urls]).toEqual(["https://example.com/path?q=1&r=2#section"]);
  });

  it("extracts a bare URL with a bracketed IPv6 authority", () => {
    const url = "http://[::1]:8080/path";
    expect([...extractUrls(url)]).toEqual([url]);
  });

  it("extracts markdown link hrefs with parentheses in the URL", () => {
    const url = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
    expect([...extractUrls(`[Wikipedia](${url})`)]).toEqual([url]);
  });

  it("keeps balanced URL parentheses and internal query punctuation", () => {
    const url = "https://example.com/v1.0/URL_(disambiguation)?a=1&b=2#section";
    expect([...extractUrls(`Visit ${url}.`)]).toEqual([url]);
  });

  it("does not extract an incomplete markdown link destination", () => {
    expect([...extractUrls("[broken](https://)")]).toEqual([]);
  });

  it.each(["[broken](https://.)", "https://.", "https:///path"])(
    "does not extract a URL without a real authority from %s",
    (text) => {
      expect([...extractUrls(text)]).toEqual([]);
    },
  );

  it("handles bare URLs with trailing closing paren as punctuation", () => {
    const urls = extractUrls("(see https://example.com/path)");
    expect([...urls]).toEqual(["https://example.com/path"]);
  });

  it("drops punctuation after an unmatched closing paren", () => {
    const urls = extractUrls("(see https://example.com/path).");
    expect([...urls]).toEqual(["https://example.com/path"]);
  });

  it("handles markdown link with angle brackets and parenthetical URL", () => {
    const url = "https://en.wikipedia.org/wiki/Special_(film)";
    expect([...extractUrls(`[link](<${url}>)`)]).toEqual([url]);
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

  it("returns lines unchanged when no URLs", () => {
    const lines = ["Hello world", "No links here"];
    expect(addOsc8Hyperlinks(lines, new Set<string>())).toEqual(lines);
  });

  it.each([
    { prefix: "Visit ", url: "https://example.com", suffix: " for info" },
    { prefix: "🦞 東京 ", url: "https://example.com/😀/e\u0301", suffix: " 🧑‍💻" },
    { prefix: "\ud800 ", url: "https://example.com/\udfff", suffix: " \udc00" },
  ])("wraps a single-line URL with OSC 8 ($url)", ({ prefix, url, suffix }) => {
    expect(addOsc8Hyperlinks([`${prefix}${url}${suffix}`], new Set([url]))).toEqual([
      `${prefix}\x1b]8;;${url}\x07${url}\x1b]8;;\x07${suffix}`,
    ]);
  });

  it.each([".", ",", ";", "!", "?", ":", "*", "_", "~", ".?!"])(
    "keeps trailing GFM punctuation %s outside terminal hyperlink targets",
    (punctuation) => {
      const url = "https://example.com/path";
      const line = `Visit ${url}${punctuation}`;

      expect(addOsc8Hyperlinks([line], extractUrls(line))).toEqual([
        `Visit \x1b]8;;${url}\x07${url}\x1b]8;;\x07${punctuation}`,
      ]);
    },
  );

  it("preserves punctuation explicitly authored in markdown hyperlink targets", () => {
    const url = "https://example.com/path.";
    const line = `Docs (${url})`;

    expect(addOsc8Hyperlinks([line], extractUrls(`[Docs](${url})`))).toEqual([
      `Docs (\x1b]8;;${url}\x07${url}\x1b]8;;\x07)`,
    ]);
  });

  it.each([".", ","])(
    "keeps authored and bare hyperlink occurrences distinct before %s",
    (punctuation) => {
      const bareUrl = "https://example.com/path";
      const authoredUrl = `${bareUrl}${punctuation}`;
      const markdown = `[Docs](${authoredUrl}) and ${bareUrl}${punctuation}`;
      const rendered = `Docs (${authoredUrl}) and ${bareUrl}${punctuation}`;

      expect(addOsc8Hyperlinks([rendered], extractUrls(markdown))).toEqual([
        `Docs (\x1b]8;;${authoredUrl}\x07${authoredUrl}\x1b]8;;\x07) and \x1b]8;;${bareUrl}\x07${bareUrl}\x1b]8;;\x07${punctuation}`,
      ]);
    },
  );

  it("keeps bidi isolation outside the exact OSC 8 target", () => {
    const url = "https://example.com/path";
    expect(addOsc8Hyperlinks([`\u2067مرحبا ${url}\u2069`], new Set([url]))).toEqual([
      `\u2067مرحبا \x1b]8;;${url}\x07${url}\x1b]8;;\x07\u2069`,
    ]);
  });

  it("wraps a URL broken across two lines", () => {
    const fullUrl = "https://example.com/very/long/path/to/resource";
    const lines = ["https://example.com/very/long/pa", "th/to/resource"];
    const result = addOsc8Hyperlinks(lines, new Set([fullUrl]));

    // Line 1: fragment should be wrapped with the full URL
    expect(result[0]).toContain(`\x1b]8;;${fullUrl}\x07`);
    // Line 2: continuation should also be wrapped
    expect(result[1]).toContain(`\x1b]8;;${fullUrl}\x07`);
  });

  it("keeps a whole code point when a wrapped continuation matches only its high surrogate", () => {
    const prefix = "https://example.com/";
    const url = `${prefix}😀/path`;

    expect(addOsc8Hyperlinks([prefix, "😁 next"], new Set([url]))).toEqual([
      `\x1b]8;;${url}\x07${prefix}\x1b]8;;\x07`,
      `\x1b]8;;${url}\x07😁\x1b]8;;\x07 next`,
    ]);
  });

  it("wraps a URL with a bracketed IPv6 authority", () => {
    const url = "http://[::1]:8080/path";
    expect(addOsc8Hyperlinks([url], new Set([url]))).toEqual([
      `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`,
    ]);
  });

  it("wraps a URL broken immediately after its scheme", () => {
    const fullUrl = "https://example.com/path";
    const result = addOsc8Hyperlinks(["https://", "example.com/path"], new Set([fullUrl]));

    expect(result[0]).toBe(`\x1b]8;;${fullUrl}\x07https://\x1b]8;;\x07`);
    expect(result[1]).toBe(`\x1b]8;;${fullUrl}\x07example.com/path\x1b]8;;\x07`);
  });

  it("does not cross-link a scheme-only fragment to a partial domain match", () => {
    const result = addOsc8Hyperlinks(["https://", "example.org"], new Set(["https://example.com"]));

    expect(result).toEqual(["https://", "example.org"]);
  });

  it("does not cross-link a scheme-only fragment to a longer URL token", () => {
    const result = addOsc8Hyperlinks(
      ["https://", "example.com/pathology"],
      new Set(["https://example.com/path"]),
    );

    expect(result).toEqual(["https://", "example.com/pathology"]);
  });

  it("does not recover a punctuated incomplete URL as a wrapped URL", () => {
    const result = addOsc8Hyperlinks(
      ["broken (https://)", "example.com"],
      new Set(["https://example.com"]),
    );

    expect(result).toEqual(["broken (https://)", "example.com"]);
  });

  it("does not wrap a punctuation-only URL body", () => {
    expect(addOsc8Hyperlinks(["https://."], new Set(["https://."]))).toEqual(["https://."]);
  });

  it("handles URL with ANSI styling codes", () => {
    const url = "https://example.com";
    // Simulate styled text: green URL
    const styledLine = `\x1b[32m${url}\x1b[0m`;
    const result = addOsc8Hyperlinks([styledLine], new Set([url]));

    // Should preserve ANSI codes and add OSC 8 around the visible URL
    expect(result[0]).toContain("\x1b[32m");
    expect(result[0]).toContain("\x1b[0m");
    expect(result[0]).toContain(`\x1b]8;;${url}\x07`);
    expect(result[0]).toContain(`\x1b]8;;\x07`);
  });

  it("handles named link rendered as text (url)", () => {
    const url = "https://github.com/org/repo";
    // pi-tui renders [text](url) as "text (url)"
    const line = `Click here (${url})`;
    const result = addOsc8Hyperlinks([line], new Set([url]));

    // The URL part should be wrapped with OSC 8
    expect(result[0]).toContain(`\x1b]8;;${url}\x07`);
  });

  it("handles multiple URLs on the same line", () => {
    const url1 = "https://foo.com";
    const url2 = "https://bar.com";
    const line = `${url1} and ${url2}`;
    const result = addOsc8Hyperlinks([line], new Set([url1, url2]));

    expect(result[0]).toContain(`\x1b]8;;${url1}\x07`);
    expect(result[0]).toContain(`\x1b]8;;${url2}\x07`);
  });

  it("does not modify lines without URL text", () => {
    const url = "https://example.com";
    const lines = ["Just some text", "No URLs here"];
    const result = addOsc8Hyperlinks(lines, new Set([url]));

    expect(result).toEqual(lines);
  });

  it.each([
    {
      name: "longest prefix",
      known: ["https://example.test/a", "https://example.test/ab"],
      fragment: "https://example.test/",
      expected: "https://example.test/ab",
    },
    {
      name: "exact match before longer prefix",
      known: ["https://example.test/ab", "https://example.test/a"],
      fragment: "https://example.test/a",
      expected: "https://example.test/a",
    },
    {
      name: "first equal-length prefix",
      known: ["https://example.test/ab", "https://example.test/aa"],
      fragment: "https://example.test/a",
      expected: "https://example.test/ab",
    },
    {
      name: "reversed equal-length prefixes",
      known: ["https://example.test/aa", "https://example.test/ab"],
      fragment: "https://example.test/a",
      expected: "https://example.test/aa",
    },
  ])("resolves a rendered fragment by $name", ({ known, fragment, expected }) => {
    expect(addOsc8Hyperlinks([fragment], new Set(known))).toEqual([
      `\x1b]8;;${expected}\x07${fragment}\x1b]8;;\x07`,
    ]);
  });

  it("wraps URLs with parentheses in markdown rendered text", () => {
    const url = "https://en.wikipedia.org/wiki/URL_(disambiguation)";
    const line = `Wikipedia (${url})`;
    const result = addOsc8Hyperlinks([line], new Set([url]));
    expect(result[0]).toBe(`Wikipedia (\x1b]8;;${url}\x07${url}\x1b]8;;\x07)`);
  });

  it("does not resolve an incomplete URL to another known URL", () => {
    const url = "https://example.com";
    const result = addOsc8Hyperlinks(["broken (https://)", url], new Set([url]));
    expect(result[0]).toBe("broken (https://)");
    expect(result[1]).toContain(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
  });

  it("handles URL split across three lines", () => {
    const fullUrl = "https://example.com/a/very/long/path/that/keeps/going/and/going";
    const lines = ["https://example.com/a/very/lon", "g/path/that/keeps/going/and/g", "oing"];
    const result = addOsc8Hyperlinks(lines, new Set([fullUrl]));

    // All three lines should have OSC 8 wrapping
    for (const line of result) {
      expect(line).toContain(`\x1b]8;;${fullUrl}\x07`);
      expect(line).toContain(`\x1b]8;;\x07`);
    }
  });
});
