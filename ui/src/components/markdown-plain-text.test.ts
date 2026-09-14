import MarkdownIt from "markdown-it";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toSanitizedMarkdownHtml, toStreamingMarkdownParts } from "./markdown.ts";

afterEach(() => vi.restoreAllMocks());

const literalSource =
  "\0<&\"' &amp; &#0;\r\n\u2028\u2029\u00a0\ufeff\ud800 🦞 中文 <img src=x onerror=alert(1)>";
const literalHtml =
  "&lt;&amp;\"' &amp;amp; &amp;#0;\n\n\n&nbsp;\ufeff\ud800 🦞 中文 &lt;img src=x onerror=alert(1)&gt;";

function fallbackHtml(text: string, assistantTranscriptRoleHeaders: boolean): string {
  const contents = assistantTranscriptRoleHeaders
    ? `<code class="assistant-transcript-role">Assistant:</code>\n<span class="markdown-plain-text-source">${text}</span>`
    : text;
  return `<div class="markdown-plain-text-fallback">${contents}</div>`;
}

describe.each([false, true])("plain-text fallback (progress: %s)", (progressBars) => {
  it.each([false, true])(
    "preserves literal text and serialized HTML (role: %s)",
    (assistantTranscriptRoleHeaders) => {
      const padding = "x".repeat(50_001);
      const source = literalSource + padding;
      const expected = fallbackHtml(literalHtml + padding, assistantTranscriptRoleHeaders);
      const options = { progressBars, assistantTranscriptRoleHeaders };

      expect(toSanitizedMarkdownHtml(source, options)).toBe(expected);
      const [stable, tail] = toStreamingMarkdownParts(source, options);
      // Use a single unbroken tail below to exercise the same fallback via streaming.
      const streamingSource = "<img src=x onerror=alert(1)>\0" + padding;
      expect(toStreamingMarkdownParts(streamingSource, options)).toEqual([
        "",
        fallbackHtml(
          "&lt;img src=x onerror=alert(1)&gt;" + padding,
          assistantTranscriptRoleHeaders,
        ),
      ]);
      expect(stable + tail).not.toContain("<img");
    },
  );

  it.each([false, true])(
    "preserves the parser-error fallback (role: %s)",
    (assistantTranscriptRoleHeaders) => {
      const render = vi.spyOn(MarkdownIt.prototype, "render").mockImplementationOnce(() => {
        throw new Error("synthetic parser failure");
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const suffix = ` failed-parser:${progressBars}:${assistantTranscriptRoleHeaders}`;

      expect(
        toSanitizedMarkdownHtml(literalSource + suffix, {
          progressBars,
          assistantTranscriptRoleHeaders,
        }),
      ).toBe(fallbackHtml(literalHtml + suffix, assistantTranscriptRoleHeaders));
      expect(render).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledOnce();
    },
  );
});
