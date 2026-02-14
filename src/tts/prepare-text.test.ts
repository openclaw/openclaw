import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../line/markdown-to-line.js";

/**
 * Tests that stripMarkdown (used in the TTS pipeline via maybeApplyTtsToPayload)
 * produces clean text suitable for speech synthesis.
 *
 * The TTS pipeline calls stripMarkdown() before sending text to TTS engines
 * (OpenAI, ElevenLabs, Edge) so that formatting symbols are not read aloud
 * (e.g. "hashtag hashtag hashtag" for ### headers).
 */
describe("TTS text preparation – stripMarkdown", () => {
  it("strips markdown headers before TTS", () => {
    expect(stripMarkdown("### System Design Basics")).toBe("System Design Basics");
    expect(stripMarkdown("## Heading\nSome text")).toBe("Heading\nSome text");
  });

  it("strips bold and italic markers before TTS", () => {
    expect(stripMarkdown("This is **important** and *useful*")).toBe(
      "This is important and useful",
    );
  });

  it("strips inline code markers before TTS", () => {
    expect(stripMarkdown("Use `consistent hashing` for distribution")).toBe(
      "Use consistent hashing for distribution",
    );
  });

  it("handles a typical LLM reply with mixed markdown", () => {
    const input = `## Heading with **bold** and *italic*

> A blockquote with \`code\`

Some ~~deleted~~ content.`;

    const result = stripMarkdown(input);

    expect(result).toBe(`Heading with bold and italic

A blockquote with code

Some deleted content.`);
  });

  it("handles markdown-heavy system design explanation", () => {
    const input = `### B-tree vs LSM-tree

**B-tree** uses _in-place updates_ while **LSM-tree** uses _append-only writes_.

> Key insight: LSM-tree optimizes for write-heavy workloads.

---

Use \`B-tree\` for read-heavy, \`LSM-tree\` for write-heavy.`;

    const result = stripMarkdown(input);

    expect(result).not.toContain("#");
    expect(result).not.toContain("**");
    expect(result).not.toContain("`");
    expect(result).not.toContain(">");
    expect(result).not.toContain("---");
    expect(result).toContain("B-tree vs LSM-tree");
    expect(result).toContain("B-tree uses in-place updates");
  });
});
