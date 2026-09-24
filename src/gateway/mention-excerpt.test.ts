import { describe, expect, it } from "vitest";
import { prepareMentionExcerpts } from "./mention-excerpt.js";

const identity = (text: string) => text;
function selection(text: string, label: string, profileId = "taylor") {
  const start = text.indexOf(label);
  expect(start).toBeGreaterThanOrEqual(0);
  return { profileId, start, end: start + label.length };
}

describe("selected mention excerpts", () => {
  it("retains immediate context before and after a mention beyond the old 2,048-character prefix", () => {
    const text = `${"Earlier background paragraph. ".repeat(180)}Before the release, @Taylor please review the spacing before we ship. ${"Later unrelated details. ".repeat(180)}`;
    const preview = prepareMentionExcerpts(text, [selection(text, "@Taylor")], identity)
      .recipients[0]!;
    expect(preview.excerpt).toContain(
      "Before the release, @Taylor please review the spacing before we ship.",
    );
    expect(preview.excerpt).toMatch(/^… /);
    expect(preview.excerpt).toMatch(/ …$/);
    expect(preview.excerpt.length).toBeLessThanOrEqual(280);
    expect(preview.excerpt.slice(preview.excerptMention.start, preview.excerptMention.end)).toBe(
      "@Taylor",
    );
  });

  it("gives distant recipients their own context and preserves multi-word selected names", () => {
    const text = `First ask @Alex Chen to review the API. ${"Separate background. ".repeat(200)}Then ask @Taylor to check the spacing.`;
    const result = prepareMentionExcerpts(
      text,
      [selection(text, "@Alex Chen", "alex"), selection(text, "@Taylor")],
      identity,
    );
    expect(result.recipients).toHaveLength(2);
    expect(result.recipients[0]!.excerpt).toContain("@Alex Chen to review the API.");
    expect(result.recipients[1]!.excerpt).toContain("@Taylor to check the spacing.");
    for (const [index, label] of ["@Alex Chen", "@Taylor"].entries()) {
      const preview = result.recipients[index]!;
      expect(preview.excerpt.slice(preview.excerptMention.start, preview.excerptMention.end)).toBe(
        label,
      );
    }
  });

  it("keeps the selected label literal through Markdown and whitespace normalization", () => {
    const text =
      "**Review** the [release](https://example.com),\n then @Alex_Chen please check **this**.";
    const preview = prepareMentionExcerpts(text, [selection(text, "@Alex_Chen")], identity)
      .recipients[0]!;
    expect(preview.excerpt).toBe("Review the release, then @Alex_Chen please check this.");
    expect(preview.excerpt.slice(preview.excerptMention.start, preview.excerptMention.end)).toBe(
      "@Alex_Chen",
    );
  });

  it("remaps offsets after a preceding secret changes length", () => {
    const text = "token=secret-value-for-test; @Taylor please check the release.";
    const redact = (value: string) => value.replace("secret-value-for-test", "***");
    const preview = prepareMentionExcerpts(text, [selection(text, "@Taylor")], redact)
      .recipients[0]!;
    expect(preview.excerpt).not.toContain("secret-value-for-test");
    expect(preview.excerpt.slice(preview.excerptMention.start, preview.excerptMention.end)).toBe(
      "@Taylor",
    );
  });

  it("does not let marker protection defeat context-sensitive redaction", () => {
    const text = "password=@Taylor and some context";
    const redact = (value: string) => value.replace("password=@Taylor", "password=[redacted]");
    expect(prepareMentionExcerpts(text, [selection(text, "@Taylor")], redact)).toEqual({
      fallback: "password=[redacted] and some context",
      recipients: [],
    });
  });

  it("does not highlight a label that was redacted", () => {
    const text = "Please ask @private-user for details.";
    const result = prepareMentionExcerpts(text, [selection(text, "@private-user")], (value) =>
      value.replaceAll("@private-user", "[redacted]"),
    );
    expect(result.fallback).toBe("Please ask [redacted] for details.");
    expect(result.recipients).toEqual([]);
  });

  it("bounds long selected labels and does not split emoji at excerpt edges", () => {
    const label = "@" + "a".repeat(255);
    const text = "😀".repeat(100) + " " + label + " " + "🦞".repeat(100);
    const preview = prepareMentionExcerpts(text, [selection(text, label)], identity).recipients[0]!;
    expect(preview.excerpt.length).toBeLessThanOrEqual(280);
    expect(preview.excerpt.isWellFormed()).toBe(true);
    expect(preview.excerpt.slice(preview.excerptMention.start, preview.excerptMention.end)).toBe(
      label,
    );
  });

  it("keeps short start/end mentions without invented ellipses", () => {
    for (const text of ["@Taylor please review.", "Please review, @Taylor"]) {
      const preview = prepareMentionExcerpts(text, [selection(text, "@Taylor")], identity)
        .recipients[0]!;
      expect(preview.excerpt).toBe(text);
    }
  });
});
