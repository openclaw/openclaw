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
