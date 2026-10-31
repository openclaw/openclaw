import { describe, expect, it } from "vitest";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const transcriptLine = (text: string) =>
  `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(text)}`;

describe("audio transcript Markdown", () => {
  it.each(["你好世界", "Hello", "Hello world", 'say "hello"\nthen continue'])(
    "keeps the generated transcript visible: %s",
    (text) => {
      const line = transcriptLine(text);
      const rendered = htmlFragment(toSanitizedMarkdownHtml(line));
      expect(rendered.querySelector("p")?.textContent).toBe(line.replaceAll('\\"', '"'));
      expect(rendered.querySelector("a")).toBeNull();
    },
  );

  it("keeps a transcript visible beside ordinary reference links", () => {
    const line = transcriptLine("Hello");
    const rendered = htmlFragment(
      toSanitizedMarkdownHtml(
        ["Before", line, "", "[Documentation][docs]", "", "[docs]: https://example.com/guide"].join(
          "\n",
        ),
      ),
    );
    expect(rendered.textContent).toContain(line);
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe("https://example.com/guide");
    expect(rendered.textContent).not.toContain("[docs]:");
  });

  it("does not let a preceding link definition consume the transcript", () => {
    const line = transcriptLine("Hello");
    const rendered = htmlFragment(
      toSanitizedMarkdownHtml(
        `[docs]: https://example.com/guide\n${line}\n\n[Documentation][docs]`,
      ),
    );
    expect(rendered.textContent).toContain(line);
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe("https://example.com/guide");
  });

  it.each(["fenced", "indented", "inline", "multiline inline"])(
    "preserves %s code examples",
    (kind) => {
      const line = transcriptLine("Hello");
      const source =
        kind === "fenced"
          ? `\`\`\`text\n${line}\n\`\`\``
          : kind === "indented"
            ? `    ${line}`
            : kind === "multiline inline"
              ? `\`\n${line}\n\``
              : `\`${line}\``;
      const rendered = htmlFragment(toSanitizedMarkdownHtml(source));
      expect(rendered.querySelector("code")?.textContent?.trim()).toBe(line);
    },
  );

  it.each(["> ", "- "])("renders transcripts inside a Markdown container: %s", (prefix) => {
    const line = transcriptLine("Hello");
    const rendered = htmlFragment(toSanitizedMarkdownHtml(`${prefix}${line}`));
    expect(rendered.textContent?.trim()).toBe(line);
  });

  it("does not promote transcript HTML to markup", () => {
    const rendered = htmlFragment(
      toSanitizedMarkdownHtml(transcriptLine("<script>alert(1)</script>")),
    );
    expect(rendered.textContent).toContain("<script>alert(1)</script>");
    expect(rendered.querySelector("script")).toBeNull();
  });
});
