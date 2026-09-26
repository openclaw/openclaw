import { describe, expect, it } from "vitest";
import { stripMarkdown } from "../shared/text/strip-markdown.js";
import {
  CODE_HEAVY_SPOKEN_FALLBACK,
  isCodeHeavySpeechText,
  normalizeSpeechText,
} from "./speech-text.js";

const speechStripOptions = { linkStyle: "label", mode: "speech" } as const;

describe("speech text normalization", () => {
  it("strips speech-hostile Markdown and decorative punctuation", () => {
    const input = `# Release notes

- Read the [guide](https://example.com/guide)
- Keep the useful detail

| Area | Status |
| --- | --- |
| Talk | Ready |

\`\`\`ts
const concise = true;
\`\`\`

✨ ✨ ✨
Really!!!!!`;

    const result = stripMarkdown(input, speechStripOptions);

    expect(result).toContain("Release notes");
    expect(result).toContain("Read the guide");
    expect(result).not.toContain("•");
    expect(result).not.toContain("https://example.com/guide");
    expect(result).toContain("Talk");
    expect(result).toContain("Status: Ready");
    expect(result).toContain("const concise = true;");
    expect(result).not.toMatch(/[#|`✨]/u);
    expect(result).toContain("Really!");
  });

  it("keeps meaningful numeric prefixes while removing decorative bullets", () => {
    expect(stripMarkdown("404. Not found", speechStripOptions)).toBe("404. Not found");
    expect(stripMarkdown("• item", speechStripOptions)).toBe("item");
  });

  it("falls back when fenced code is at least half of the reply", () => {
    const input = `Brief note.

\`\`\`ts
export function renderAnswer() {
  return "most of this reply is code";
}
\`\`\``;

    expect(isCodeHeavySpeechText(input)).toBe(true);
    expect(normalizeSpeechText(input)).not.toBe(CODE_HEAVY_SPOKEN_FALLBACK);
  });

  it("keeps prose when fenced code is less than half of the reply", () => {
    const input = `This explanation is intentionally long enough to remain the main part of the response. It tells the listener what the example does and why it matters before showing one tiny snippet.

\`\`\`ts
const ready = true;
\`\`\``;

    expect(isCodeHeavySpeechText(input)).toBe(false);
    const result = normalizeSpeechText(input);
    expect(result).toContain("This explanation is intentionally long enough");
    expect(result).toContain("const ready = true;");
  });

  it.each([
    [
      "inline code",
      "```printf```\n\nThis explanation is ordinary prose and should be spoken in full.",
    ],
    [
      "prose after a quoted fence",
      "> ```\n> x\n\nThis explanation is ordinary prose and should be spoken in full.",
    ],
  ])("does not classify %s as fenced code", (_name, text) => {
    expect(isCodeHeavySpeechText(text)).toBe(false);
  });

  it("recognizes a fence opened on the list marker line", () => {
    const text = '- ```js\n  const detailedAnswer = "this body dominates the reply";\n  ```';
    expect(isCodeHeavySpeechText(text)).toBe(true);
  });

  it.each([
    ["1234567", false],
    ["12345678", true],
    ["12345  ", false],
    ["123456  ", true],
  ])("keeps the inclusive half-code boundary for %j", (code, expected) => {
    expect(isCodeHeavySpeechText(`\`\`\`\n${code}\n\`\`\``)).toBe(expected);
  });

  it("keeps blockquoted code and surrounding prose aligned with Markdown stripping", () => {
    const input = `> This explanation is deliberately much longer than the code it introduces, so it remains the reply's main content for speech.
>
> \`\`\`ts
> const ready = true;
> \`\`\``;

    expect(isCodeHeavySpeechText(input)).toBe(false);
    expect(normalizeSpeechText(input)).toContain("This explanation is deliberately much longer");
    expect(normalizeSpeechText(input)).toContain("const ready = true;");
  });
});
