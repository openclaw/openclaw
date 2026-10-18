import { describe, expect, it } from "vitest";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

function selected(
  source: string,
  label: string,
  profileId = "profile-ada",
  start = source.indexOf(label),
) {
  return { profileId, start, end: start + label.length };
}

function render(source: string, humanMentions: ReturnType<typeof selected>[] = []) {
  return htmlFragment(toSanitizedMarkdownHtml(source, { humanMentions }));
}

describe("explicit human mention Markdown", () => {
  it("keeps original Unicode labels and only decorates the selected occurrence across line normalization", () => {
    const source = "🦞 **Hello**\r\n@Ada Lovelace cc @Ada Lovelace";
    const label = "@Ada Lovelace";
    const fragment = render(source, [
      selected(source, label, "canonical-person", source.lastIndexOf(label)),
    ]);
    const references = fragment.querySelectorAll("openclaw-person-reference");
    expect(references).toHaveLength(1);
    expect(references[0]?.getAttribute("profile-id")).toBe("canonical-person");
    expect(references[0]?.getAttribute("label")).toBe(label);
    expect(fragment.textContent?.trim()).toBe("🦞 Hello\n@Ada Lovelace cc @Ada Lovelace");
    expect(fragment.querySelector("strong")?.textContent).toBe("Hello");
  });

  it.each([
    { label: '@Ada_One & <img src=x onerror="alert(1)">', prefix: "Hello ", suffix: "" },
    { label: "@Ada `One`", prefix: "Hello ", suffix: "" },
    { label: "@Ada", prefix: "[Hello ", suffix: "]" },
  ])("keeps selected labels literal: $label", ({ label, prefix, suffix }) => {
    const source = prefix + label + suffix;
    const fragment = render(source, [selected(source, label)]);
    expect(fragment.querySelector("openclaw-person-reference")?.textContent).toBe(label);
    expect(fragment.querySelector("img,script,em,code,[onerror]")).toBeNull();
    expect(fragment.textContent?.trim()).toBe(source);
  });

  it.each([
    "`@Ada`",
    "```text\n@Ada\n```",
    "    @Ada",
    "[@Ada](https://example.test)",
    "[link](https://example.test/@Ada)",
    "https://example.test/@Ada",
    "https://@Ada",
    "/tmp/@Ada.md",
    "![@Ada](https://example.test/image.png)",
    '<span title="@Ada">example</span>',
  ])("does not create person controls inside code, links or HTML attributes: %s", (source) => {
    const rendered = toSanitizedMarkdownHtml(source, {
      fileLinks: true,
      humanMentions: [selected(source, "@Ada")],
    });
    const fragment = htmlFragment(rendered);
    expect(fragment.querySelector("openclaw-person-reference")).toBeNull();
    expect(rendered).not.toContain("openclawhumanmention");
    expect(rendered).toContain("@Ada");
  });

  it.each([
    [
      "Before [@Ada $&](https://example.test) after",
      0,
      ["@Ada $&"],
      "https://example.test",
      "@Ada $&",
      "Before @Ada $& after",
    ],
    ["[@Ada]\n\n[@Ada]: /person", 0, ["@Ada"], "/person", "@Ada"],
    ["[@Ada][]\n\n[@Ada]: /person", 0, ["@Ada"], "/person", "@Ada"],
    ["[label][@Ada]\n\n[@Ada]: /person", 0, ["@Ada"], "/person", "label"],
    ["[@Ada]\n\n[@Ada]: /person\n[@Ada]: /other", 1, ["@Ada"], "/person", "@Ada"],
    ["[@Ada @Bob][]\n\n[@Ada @Bob]: /people", 0, ["@Ada", "@Bob"], "/people", "@Ada @Bob"],
  ] as const)(
    "restores selected labels inside links: %s",
    (source, occurrence, labels, href, text, content?: string) => {
      const mentions = labels.map((label) =>
        selected(
          source,
          label,
          "profile-" + label,
          occurrence ? source.indexOf(label, source.indexOf(label) + 1) : source.indexOf(label),
        ),
      );
      const rendered = toSanitizedMarkdownHtml(source, { humanMentions: mentions });
      const fragment = htmlFragment(rendered);
      expect(rendered).not.toContain("openclawhumanmention");
      if (content !== undefined) {
        expect(fragment.textContent?.trim()).toBe(content);
      }
      expect(fragment.querySelector("a")?.getAttribute("href")).toBe(href);
      expect(fragment.querySelector("a")?.textContent).toBe(text);
      expect(fragment.querySelector("openclaw-person-reference")).toBeNull();
      expect(fragment.textContent).not.toContain("openclawhumanmention");
    },
  );

  it("preserves reference-style images", () => {
    const source = "![@Ada][]\n\n[@Ada]: https://example.test/person.png";
    expect(toSanitizedMarkdownHtml(source, { humanMentions: [selected(source, "@Ada")] })).toBe(
      toSanitizedMarkdownHtml(source),
    );
  });

  it.each([
    "[@Ada]\n\n[OPENCLAWHUMANMENTION0X0END]: /literal\n\n@Ada",
    "[OPENCLAWHUMANMENTION0X0END]\n\n[@Ada]: /person\n\n@Ada",
  ])("does not alias authored reference labels to a generated marker: %s", (source) => {
    const fragment = render(source, [
      selected(source, "@Ada", "profile-ada", source.lastIndexOf("@Ada")),
    ]);
    expect(fragment.querySelector("a")).toBeNull();
    expect(fragment.querySelectorAll("openclaw-person-reference")).toHaveLength(1);
  });

  it.each([
    {
      source:
        '@Ada <openclaw-person-reference profile-id="secret" label="@Ada">@Ada</openclaw-person-reference>',
      mentions: [],
    },
    {
      source: "@Ada",
      mentions: [
        { profileId: "one", start: 0, end: 4 },
        { profileId: "two", start: 0, end: 4 },
      ],
    },
  ])(
    "does not invent identity for untrusted or overlapping selections: $source",
    ({ source, mentions }) => {
      const fragment = render(source, mentions);
      expect(fragment.querySelector("openclaw-person-reference")).toBeNull();
      expect(fragment.textContent?.trim()).toBe(source);
    },
  );

  it("keys cached rendering by explicit identity, including the absence of a selection", () => {
    for (const id of ["first", "second", null, "first"]) {
      const source = "@Same Name";
      const fragment = render(source, id ? [selected(source, source, id)] : []);
      expect(
        fragment.querySelector("openclaw-person-reference")?.getAttribute("profile-id") ?? null,
      ).toBe(id);
    }
  });

  it("never leaks placeholders from oversized fallback or the streaming adapter", () => {
    const source = "@Ada " + "long text ".repeat(4500);
    const options = { humanMentions: [selected(source, "@Ada")] };
    const fallback = htmlFragment(toSanitizedMarkdownHtml(source, options));
    expect(fallback.textContent).toBe(source);
    expect(fallback.querySelector("openclaw-person-reference")).toBeNull();
    const [stable, tail] = toStreamingMarkdownParts("@Ada", options);
    expect(htmlFragment(stable).querySelector("openclaw-person-reference")?.textContent).toBe(
      "@Ada",
    );
    expect(tail).toBe("");
  });
});
