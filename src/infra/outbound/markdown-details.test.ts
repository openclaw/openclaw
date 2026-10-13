import { describe, expect, it } from "vitest";
import { flattenMarkdownDetails } from "./markdown-details.js";

describe("flattenMarkdownDetails", () => {
  it("uses the default label when summary is missing or empty", () => {
    expect(flattenMarkdownDetails("<details>body</details>")).toBe("**Details**\n\nbody");
    expect(flattenMarkdownDetails("<details><summary> </summary>body</details>")).toBe(
      "**Details**\n\nbody",
    );
  });

  it("preserves block boundaries around flattened details", () => {
    expect(flattenMarkdownDetails("before<details>inside</details>after")).toBe(
      "before\n\n**Details**\n\ninside\n\nafter",
    );
    expect(flattenMarkdownDetails("<details>inside</details>\nafter")).toBe(
      "**Details**\n\ninside\n\nafter",
    );
  });

  it("does not duplicate multiline container prefixes", () => {
    expect(
      flattenMarkdownDetails("> <details>\n> <summary>A</summary>\n>\n> body\n> </details>"),
    ).toBe("> **A**\n>\n> body");
    expect(
      flattenMarkdownDetails("10. <details>\n    <summary>A</summary>\n\n    body\n    </details>"),
    ).toBe("10. **A**\n\n    body");
  });

  it.each([[31, "**A**\n\nonelater\n\nmiddle\n\n**B**\n\ntwo"]] as const)(
    "preserves child rendering at parent depth %i",
    (depth, expected) => {
      const prefix = "<summary>".repeat(depth);
      const suffix = "</summary>".repeat(depth);
      const children =
        "<details><summary>A</summary>one<summary>later</summary></details>" +
        "middle<details><summary>B</summary>two</details>";

      expect(flattenMarkdownDetails(`${prefix}<summary>${children}</summary>${suffix}`)).toBe(
        expected,
      );
      expect(
        flattenMarkdownDetails(
          `${prefix}<details><summary>Body</summary>${children}</details>${suffix}`,
        ),
      ).toBe(`**Body**\n\n${expected}`);
      expect(
        flattenMarkdownDetails(
          `${prefix}<details><summary>${children}</summary>tail</details>${suffix}`,
        ),
      ).toBe(`**${expected}**\n\ntail`);
    },
  );

  it("flattens unterminated details without leaking structural tags", () => {
    expect(flattenMarkdownDetails("<details><summary>More</summary>partial")).toBe(
      "**More**\n\npartial",
    );
  });

  it("closes an unterminated summary with its containing details", () => {
    expect(flattenMarkdownDetails("<details><summary>More</details>after")).toBe(
      "**More**\n\nafter",
    );
  });

  it("does not flatten custom elements with details-like names", () => {
    const markdown = "<details-widget>body</details-widget>";
    expect(flattenMarkdownDetails(markdown)).toBe(markdown);
  });

  it("leaves backslash-escaped disclosure tags unchanged", () => {
    const markdown = "\\<details>literal\\</details>";
    expect(flattenMarkdownDetails(markdown)).toBe(markdown);
  });

  it.each([["\r\n a\r\n \r\n", " a"]])(
    "trims complete blank lines without changing body content in %j",
    (body, expected) => {
      expect(flattenMarkdownDetails(`<details>${body}</details>`)).toBe(
        `**Details**\n\n${expected}`,
      );
    },
  );

  it("stays responsive on a long blank-line run inside a details body", () => {
    // A blank-line run that ends on anything else made the previous
    // `(?:\r?\n[ \t]*)+$` restart from every position in the run.
    const body = `a${"\n".repeat(60_000)}X`;
    const started = process.hrtime.bigint();
    const flattened = flattenMarkdownDetails(`<details>${body}</details>`);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(flattened).toBe(`**Details**\n\n${body}`);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
