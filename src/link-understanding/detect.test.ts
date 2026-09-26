// Link detection tests cover ordering, dedupe, markdown suppression, and SSRF hostname filtering.
import { describe, expect, it } from "vitest";
import { extractLinksFromMessage } from "./detect.js";

describe("extractLinksFromMessage", () => {
  it("extracts bare http/https URLs in order", () => {
    const links = extractLinksFromMessage("see https://a.example and http://b.test");
    expect(links).toEqual(["https://a.example", "http://b.test"]);
  });

  it("dedupes links and enforces maxLinks", () => {
    const links = extractLinksFromMessage("https://a.example https://a.example https://b.test", {
      maxLinks: 1,
    });
    expect(links).toEqual(["https://a.example"]);
  });

  it("ignores markdown links", () => {
    const links = extractLinksFromMessage("[doc](https://docs.example) https://bare.example");
    expect(links).toEqual(["https://bare.example"]);
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
    ["double-quoted title", '[doc](https://docs.example "Docs")'],
    ["single-quoted title", "[doc](https://docs.example 'Docs')"],
    ["parenthesized title", "[doc](https://docs.example (Docs))"],
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

  it.each([
    ["unterminated title", '[doc](https://docs.example "Docs)'],
    ["escaped closing delimiter", '[doc](https://docs.example "t\\")'],
  ])("does not strip a link with an %s", (_name, message) => {
    expect(extractLinksFromMessage(message)).toStrictEqual(["https://docs.example"]);
  });

  it("blocks 127.0.0.1", () => {
    const links = extractLinksFromMessage("http://127.0.0.1/test https://ok.test");
    expect(links).toEqual(["https://ok.test"]);
  });

  it("blocks localhost and common loopback addresses", () => {
    expect(extractLinksFromMessage("http://localhost/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://localhost.localdomain/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://foo.localhost/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://service.local/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://service.internal/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://0.0.0.0/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://[::1]/secret")).toStrictEqual([]);
  });

  it("blocks private network ranges", () => {
    expect(extractLinksFromMessage("http://10.0.0.1/internal")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://172.16.0.1/internal")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://192.168.1.1/internal")).toStrictEqual([]);
  });

  it("blocks link-local and cloud metadata addresses", () => {
    expect(extractLinksFromMessage("http://169.254.169.254/latest/meta-data/")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://169.254.1.1/test")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://metadata.google.internal/computeMetadata/v1/")).toEqual(
      [],
    );
  });

  it("blocks CGNAT range used by Tailscale", () => {
    expect(extractLinksFromMessage("http://100.100.50.1/test")).toStrictEqual([]);
  });

  it("blocks private and mapped IPv6 addresses", () => {
    expect(extractLinksFromMessage("http://[::ffff:127.0.0.1]/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://[2001:db8:1234::5efe:127.0.0.1]/secret")).toStrictEqual(
      [],
    );
    expect(extractLinksFromMessage("http://[fe80::1]/secret")).toStrictEqual([]);
    expect(extractLinksFromMessage("http://[fc00::1]/secret")).toStrictEqual([]);
  });

  it("allows legitimate public URLs", () => {
    expect(extractLinksFromMessage("https://example.com/page")).toEqual([
      "https://example.com/page",
    ]);
    expect(extractLinksFromMessage("https://8.8.8.8/dns")).toEqual(["https://8.8.8.8/dns"]);
  });

  it.each([
    ["a comma mid-sentence", "see https://example.com/a, then tell me", "https://example.com/a"],
    ["a period", "Check https://example.com/a.", "https://example.com/a"],
    ["an exclamation mark", "wow https://example.com/a!", "https://example.com/a"],
    ["a question mark", "https://example.com/a?", "https://example.com/a"],
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
  });

  it("preserves punctuation inside the URL and trims only the token-final character", () => {
    // Query commas and periods inside the URL survive untouched; the trim
    // applies only when prose punctuation ends the bare token, matching the
    // GFM autolink trailing-punctuation rule.
    expect(extractLinksFromMessage("see https://example.com/search?q=a,b then go")).toStrictEqual([
      "https://example.com/search?q=a,b",
    ]);
    expect(extractLinksFromMessage("https://example.com/search?q=a,b")).toStrictEqual([
      "https://example.com/search?q=a,b",
    ]);
    expect(
      extractLinksFromMessage("look at https://example.com/search?q=a,b, and more"),
    ).toStrictEqual(["https://example.com/search?q=a,b"]);
    expect(extractLinksFromMessage("end of sentence https://example.com/a?b=1.")).toStrictEqual([
      "https://example.com/a?b=1",
    ]);
  });

  it("resolves the ambiguous token-final comma by preferring the prose reading", () => {
    // Authored URLs that genuinely end in list punctuation, e.g. a trailing
    // comma of ?ids=1,2,, are fetched without it; the same tradeoff GitHub's
    // autolink extension makes. Pinning this so the rule stays deliberate.
    expect(extractLinksFromMessage("https://example.com/x?ids=1,2,")).toStrictEqual([
      "https://example.com/x?ids=1,2",
    ]);
  });
});
