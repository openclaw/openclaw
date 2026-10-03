import { describe, expect, it } from "vitest";
import { extractLinksFromMessage } from "./detect.js";

describe("extractLinksFromMessage", () => {
  it("dedupes links and enforces maxLinks", () => {
    const links = extractLinksFromMessage(
      "https://a.example https://a.example https://b.test https://c.test",
      { maxLinks: 2 },
    );
    expect(links).toEqual(["https://a.example", "https://b.test"]);
  });

  it("ignores markdown links whose label contains brackets", () => {
    // The closing "]" inside the label must not break markdown stripping, otherwise
    // the citation URL leaks out as a bare link (with a stray trailing ")").
    const links = extractLinksFromMessage(
      "Check [my notes [v2]](https://internal.example/doc) for details",
    );
    expect(links).toStrictEqual([]);
  });

  it.each([
    ["escaped double quote", '[doc](https://docs.example "A \\"quoted\\" title")'],
    ["escaped single quote", "[doc](https://docs.example 'A \\'quoted\\' title')"],
    ["escaped parenthesis", "[doc](https://docs.example (a \\(paren\\) title))"],
    ["title line break", '[doc](https://docs.example "line one\nline two")'],
    ["angle destination", '[doc](<https://docs.example/a b> "Docs")'],
    ["balanced destination parentheses", "[doc](https://docs.example/a_(b))"],
    ["escaped destination parenthesis", String.raw`[doc](https://docs.example/a\)b)`],
  ])("ignores markdown links with a %s", (_name, markdownLink) => {
    expect(extractLinksFromMessage(`${markdownLink} https://bare.example`)).toStrictEqual([
      "https://bare.example",
    ]);
  });

  it("does not strip a link with an escaped closing delimiter", () => {
    expect(extractLinksFromMessage('[doc](https://docs.example "t\\")')).toStrictEqual([
      "https://docs.example",
    ]);
  });

  it("blocks 127.0.0.1", () => {
    const links = extractLinksFromMessage("http://127.0.0.1/test https://ok.test");
    expect(links).toEqual(["https://ok.test"]);
  });

  it("blocks private IPv4 embedded in an ISATAP URL", () => {
    expect(extractLinksFromMessage("http://[2001:db8:1234::5efe:127.0.0.1]/secret")).toStrictEqual(
      [],
    );
  });
});

describe("trimTrailingProsePunctuation", () => {
  it.each([
    ["a comma mid-sentence", "see https://example.com/a, then tell me", "https://example.com/a"],
    ["a period", "Check https://example.com/a.", "https://example.com/a"],
    ["an exclamation mark", "wow https://example.com/a!", "https://example.com/a"],
    ["a colon", "link: https://example.com/a:", "https://example.com/a"],
    ["double quotes", 'open "https://example.com/a" now', "https://example.com/a"],
    ["unbalanced parentheses", "(see https://example.com/a)", "https://example.com/a"],
    ["stacked punctuation", "see https://example.com/a).", "https://example.com/a"],
    ["an ellipsis", "https://example.com/a…", "https://example.com/a"],
  ])("trims %s from a bare link", (_name, message, expected) => {
    expect(extractLinksFromMessage(message)).toStrictEqual([expected]);
  });

  it("dedupes a link once its trailing punctuation is trimmed", () => {
    const links = extractLinksFromMessage("https://example.com/a https://example.com/a,");
    expect(links).toStrictEqual(["https://example.com/a"]);
  });

  it("keeps URL suffixes that are meaningful", () => {
    expect(extractLinksFromMessage("https://en.wikipedia.org/wiki/Foo_(bar)")).toStrictEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
    expect(extractLinksFromMessage("https://example.com/page/")).toStrictEqual([
      "https://example.com/page/",
    ]);
    expect(extractLinksFromMessage("https://example.com/search?q=foo")).toStrictEqual([
      "https://example.com/search?q=foo",
    ]);
    expect(extractLinksFromMessage("https://example.com/a(b)_c.")).toStrictEqual([
      "https://example.com/a(b)_c",
    ]);
    expect(extractLinksFromMessage("read (https://en.wikipedia.org/wiki/Foo_(bar))")).toStrictEqual(
      ["https://en.wikipedia.org/wiki/Foo_(bar)"],
    );
  });

  it("trims prose punctuation after a trailing slash", () => {
    // The path-separator root is content a URL can end on, so the prose
    // delimiter that follows it is still trimmed. Authored literal destinations
    // that truly end in punctuation use the angle-bracket form.
    expect(extractLinksFromMessage("see https://example.com/, then go")).toStrictEqual([
      "https://example.com/",
    ]);
    expect(extractLinksFromMessage("(read https://example.com/)")).toStrictEqual([
      "https://example.com/",
    ]);
    expect(extractLinksFromMessage("visit https://example.com/page/.")).toStrictEqual([
      "https://example.com/page/",
    ]);
    expect(extractLinksFromMessage("https://example.com/a/,")).toStrictEqual([
      "https://example.com/a/",
    ]);
  });

  it("trims prose punctuation after a non-ASCII path character", () => {
    // The predecessor guard is Unicode-aware: an accented or non-Latin path
    // root is word content, so the ASCII prose delimiter that follows it is
    // still trimmed rather than surviving onto the fetched path.
    expect(extractLinksFromMessage("see https://example.com/café, then go")).toStrictEqual([
      "https://example.com/caf\u00e9",
    ]);
    expect(extractLinksFromMessage("visit https://example.com/élève.")).toStrictEqual([
      "https://example.com/\u00e9l\u00e8ve",
    ]);
    expect(extractLinksFromMessage("https://example.com/日本,")).toStrictEqual([
      "https://example.com/日本",
    ]);
  });

  it("trims only path-region prose punctuation and keeps the query verbatim", () => {
    // Query commas and periods inside the URL survive untouched; the trim
    // applies when prose punctuation ends the bare token before a query or
    // fragment delimiter begins.
    expect(extractLinksFromMessage("see https://example.com/search?q=a,b then go")).toStrictEqual([
      "https://example.com/search?q=a,b",
    ]);
    expect(extractLinksFromMessage("https://example.com/search?q=a,b")).toStrictEqual([
      "https://example.com/search?q=a,b",
    ]);
  });

  it("preserves authored terminal values inside query and fragment", () => {
    // From a query or fragment delimiter onward the token is treated as the
    // authored value: a terminal comma, period, or even a bare "?" survives
    // verbatim, because rewriting it can change the fetched page. Accepted
    // tradeoff: sentence punctuation directly after a queried URL is kept.
    expect(extractLinksFromMessage("https://example.com/x?ids=1,2,")).toStrictEqual([
      "https://example.com/x?ids=1,2,",
    ]);
    expect(extractLinksFromMessage("end https://example.com/a?b=1.")).toStrictEqual([
      "https://example.com/a?b=1.",
    ]);
    expect(extractLinksFromMessage("section https://example.com/page#intro.")).toStrictEqual([
      "https://example.com/page#intro.",
    ]);
    expect(extractLinksFromMessage("https://example.com/a?")).toStrictEqual([
      "https://example.com/a?",
    ]);
    expect(
      extractLinksFromMessage("look at https://example.com/search?q=a,b, and more"),
    ).toStrictEqual(["https://example.com/search?q=a,b,"]);
  });

  it("preserves authored terminal closers inside query and fragment", () => {
    // A terminal closer after a delimiter is part of the authored value that the
    // URL parser keeps, so it reaches the guarded fetch whole. Accepted tradeoff:
    // a parenthesis wrapped around a queried link survives, and that URL may 404
    // the way it already does on main.
    expect(extractLinksFromMessage("https://example.com/search?q=foo)")).toStrictEqual([
      "https://example.com/search?q=foo)",
    ]);
    expect(extractLinksFromMessage("https://example.com/page#intro)")).toStrictEqual([
      "https://example.com/page#intro)",
    ]);
    expect(extractLinksFromMessage("(link https://example.com/a?q=1)")).toStrictEqual([
      "https://example.com/a?q=1)",
    ]);
    expect(extractLinksFromMessage("see https://en.wikipedia.org/wiki/Foo_(bar)")).toStrictEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });
});

describe("angle-bracket literal links", () => {
  it("fetches a punctuation-ending path verbatim", () => {
    expect(extractLinksFromMessage("see <https://example.com/Hello!> now")).toStrictEqual([
      "https://example.com/Hello!",
    ]);
    expect(extractLinksFromMessage("<https://example.com/a)>")).toStrictEqual([
      "https://example.com/a)",
    ]);
  });

  it("keeps balanced closers inside the literal whole", () => {
    expect(extractLinksFromMessage("<https://en.wikipedia.org/wiki/Foo_(bar)>")).toStrictEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("never leaks the surrounding brackets into the fetched URL", () => {
    expect(extractLinksFromMessage("wow <https://example.com/a!>")).toStrictEqual([
      "https://example.com/a!",
    ]);
  });

  it("dedupes against the trimmed bare form and applies the same guards", () => {
    expect(extractLinksFromMessage("<https://example.com/a> https://example.com/a,")).toStrictEqual(
      ["https://example.com/a"],
    );
    expect(extractLinksFromMessage("<http://127.0.0.1/secret>")).toStrictEqual([]);
  });
});
