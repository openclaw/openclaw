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

describe("explicit human mention Markdown", () => {
  it("keeps original Unicode labels and only decorates the selected occurrence across line normalization", () => {
    const source = "🦞 **Hello**\r\n@Ada Lovelace cc @Ada Lovelace";
    const label = "@Ada Lovelace";
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(source, {
        humanMentions: [selected(source, label, "canonical-person", source.lastIndexOf(label))],
      }),
    );
    const references = fragment.querySelectorAll("openclaw-person-reference");
    expect(references).toHaveLength(1);
    expect(references[0]?.getAttribute("profile-id")).toBe("canonical-person");
    expect(references[0]?.getAttribute("label")).toBe(label);
    expect(fragment.textContent?.trim()).toBe("🦞 Hello\n@Ada Lovelace cc @Ada Lovelace");
    expect(fragment.querySelector("strong")?.textContent).toBe("Hello");
  });

  it("keeps selected names literal even when they contain Markdown or HTML syntax", () => {
    const label = '@Ada_One & <img src=x onerror="alert(1)">';
    const source = "Hello " + label;
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(source, { humanMentions: [selected(source, label)] }),
    );
    expect(fragment.querySelector("openclaw-person-reference")?.textContent).toBe(label);
    expect(fragment.querySelector("img,script,em,[onerror]")).toBeNull();
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

  it.each(["$&", "$$", "$`", "$'"])(
    "restores %s literally inside an existing Markdown link",
    (suffix) => {
      const label = "@Ada " + suffix;
      const source = "Before [" + label + "](https://example.test) after";
      const rendered = toSanitizedMarkdownHtml(source, {
        humanMentions: [selected(source, label)],
      });
      const fragment = htmlFragment(rendered);
      expect(fragment.querySelector("a")?.textContent).toBe(label);
      expect(fragment.textContent?.trim()).toBe("Before " + label + " after");
      expect(rendered).not.toContain("openclawhumanmention");
    },
  );

  it("preserves backticks contained entirely in a selected person label", () => {
    const label = "@Ada `One`";
    const source = "Hello " + label;
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(source, { humanMentions: [selected(source, label)] }),
    );
    expect(fragment.querySelector("openclaw-person-reference")?.textContent).toBe(label);
    expect(fragment.querySelector("code")).toBeNull();
    expect(fragment.textContent?.trim()).toBe(source);
  });

  it.each([
    ["[@Ada]\n\n[@Ada]: /person", 0],
    ["[@Ada][]\n\n[@Ada]: /person", 0],
    ["[label][@Ada]\n\n[@Ada]: /person", 0],
    ["[Person @Ada]\n\n[Person @Ada]: /person", 0],
    ["[@Ada]\n\n[@Ada]: /person", 1],
    ["[@Ada]\n\n[@Ada]: /person\n[@Ada]: /other", 1],
  ] as const)(
    "preserves reference links when a selected span masks a label: %s (%s)",
    (source, occurrence) => {
      const start =
        occurrence === 0
          ? source.indexOf("@Ada")
          : source.indexOf("@Ada", source.indexOf("@Ada") + 1);
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(source, {
          humanMentions: [selected(source, "@Ada", "profile-ada", start)],
        }),
      );
      expect(fragment.querySelector("a")?.getAttribute("href")).toBe("/person");
      expect(fragment.querySelector("openclaw-person-reference")).toBeNull();
      expect(fragment.textContent).not.toContain("openclawhumanmention");
    },
  );

  it("resolves a reference label containing multiple selected people", () => {
    const source = "[@Ada @Bob][]\n\n[@Ada @Bob]: /people";
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(source, {
        humanMentions: [selected(source, "@Ada"), selected(source, "@Bob", "profile-bob")],
      }),
    );
    expect(fragment.querySelector("a")?.getAttribute("href")).toBe("/people");
    expect(fragment.querySelector("a")?.textContent).toBe("@Ada @Bob");
    expect(fragment.querySelector("openclaw-person-reference")).toBeNull();
  });

  it("keeps a selected person control inside brackets that are not a reference link", () => {
    const source = "[Hello @Ada]";
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(source, {
        humanMentions: [selected(source, "@Ada")],
      }),
    );
    expect(fragment.querySelector("openclaw-person-reference")?.textContent).toBe("@Ada");
    expect(fragment.textContent?.trim()).toBe(source);
  });

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
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(source, {
        humanMentions: [selected(source, "@Ada", "profile-ada", source.lastIndexOf("@Ada"))],
      }),
    );
    expect(fragment.querySelector("a")).toBeNull();
    expect(fragment.querySelectorAll("openclaw-person-reference")).toHaveLength(1);
  });

  it("does not trust raw custom element markup or infer identity from plain names", () => {
    const source =
      '@Ada <openclaw-person-reference profile-id="secret" label="@Ada">@Ada</openclaw-person-reference>';
    const fragment = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(fragment.querySelector("openclaw-person-reference")).toBeNull();
    expect(fragment.textContent?.trim()).toBe(source);
  });

  it.each([
    [{ profileId: "person", start: -1, end: 4 }],
    [{ profileId: "person", start: 0, end: 100 }],
    [{ profileId: "", start: 0, end: 4 }],
    [
      { profileId: "one", start: 0, end: 4 },
      { profileId: "two", start: 0, end: 4 },
    ],
  ])("leaves invalid or overlapping persisted spans unformatted: %j", (...humanMentions) => {
    const fragment = htmlFragment(toSanitizedMarkdownHtml("@Ada", { humanMentions }));
    expect(fragment.querySelector("openclaw-person-reference")).toBeNull();
    expect(fragment.textContent?.trim()).toBe("@Ada");
  });

  it("keys cached rendering by explicit identity, including the absence of a selection", () => {
    for (const id of ["first", "second", null, "first"]) {
      const source = "@Same Name";
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(source, {
          humanMentions: id ? [selected(source, source, id)] : [],
        }),
      );
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
