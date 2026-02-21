import { describe, expect, it } from "vitest";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  wrapFileReferencesInHtml,
} from "./format.js";

describe("wrapFileReferencesInHtml", () => {
  it("wraps supported file references and paths", () => {
    const cases = [
      ["Check README.md", "Check <code>README.md</code>"],
      ["See HEARTBEAT.md for status", "See <code>HEARTBEAT.md</code> for status"],
      ["Check main.go", "Check <code>main.go</code>"],
      ["Run script.py", "Run <code>script.py</code>"],
      ["Check backup.pl", "Check <code>backup.pl</code>"],
      ["Run backup.sh", "Run <code>backup.sh</code>"],
      ["Look at squad/friday/HEARTBEAT.md", "Look at <code>squad/friday/HEARTBEAT.md</code>"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(wrapFileReferencesInHtml(input), input).toContain(expected);
    }
  });

  it("does not wrap inside protected html contexts", () => {
    const cases = [
      "Already <code>wrapped.md</code> here",
      "<pre><code>README.md</code></pre>",
      '<a href="README.md">Link</a>',
      'Visit <a href="https://example.com/README.md">example.com/README.md</a>',
    ] as const;
    for (const input of cases) {
      const result = wrapFileReferencesInHtml(input);
      expect(result, input).toBe(input);
    }
    expect(wrapFileReferencesInHtml(cases[0])).not.toContain("<code><code>");
  });

  it("handles mixed content correctly", () => {
    const result = wrapFileReferencesInHtml("Check README.md and CONTRIBUTING.md");
    expect(result).toContain("<code>README.md</code>");
    expect(result).toContain("<code>CONTRIBUTING.md</code>");
  });

  it("handles boundary and punctuation wrapping cases", () => {
    const cases = [
      { input: "No markdown files here", contains: undefined },
      { input: "File.md at start", contains: "<code>File.md</code>" },
      { input: "Ends with file.md", contains: "<code>file.md</code>" },
      { input: "See README.md.", contains: "<code>README.md</code>." },
      { input: "See README.md,", contains: "<code>README.md</code>," },
      { input: "(README.md)", contains: "(<code>README.md</code>)" },
      { input: "README.md:", contains: "<code>README.md</code>:" },
    ] as const;

    for (const testCase of cases) {
      const result = wrapFileReferencesInHtml(testCase.input);
      if (!testCase.contains) {
        expect(result).not.toContain("<code>");
        continue;
      }
      expect(result).toContain(testCase.contains);
    }
  });

  it("de-linkifies auto-linkified anchors for plain files and paths", () => {
    const cases = [
      {
        input: '<a href="http://README.md">README.md</a>',
        expected: "<code>README.md</code>",
      },
      {
        input: '<a href="http://squad/friday/HEARTBEAT.md">squad/friday/HEARTBEAT.md</a>',
        expected: "<code>squad/friday/HEARTBEAT.md</code>",
      },
    ] as const;
    for (const testCase of cases) {
      expect(wrapFileReferencesInHtml(testCase.input)).toBe(testCase.expected);
    }
  });

  it("preserves explicit links where label differs from href", () => {
    const cases = [
      '<a href="http://README.md">click here</a>',
      '<a href="http://other.md">README.md</a>',
    ] as const;
    for (const input of cases) {
      expect(wrapFileReferencesInHtml(input)).toBe(input);
    }
  });

  it("wraps file ref after closing anchor tag", () => {
    const input = '<a href="https://example.com">link</a> then README.md';
    const result = wrapFileReferencesInHtml(input);
    expect(result).toContain("</a> then <code>README.md</code>");
  });
});

describe("renderTelegramHtmlText - file reference wrapping", () => {
  it("wraps file references in markdown mode", () => {
    const result = renderTelegramHtmlText("Check README.md");
    expect(result).toContain("<code>README.md</code>");
  });

  it("does not wrap in HTML mode (trusts caller markup)", () => {
    // textMode: "html" should pass through unchanged - caller owns the markup
    const result = renderTelegramHtmlText("Check README.md", { textMode: "html" });
    expect(result).toBe("Check README.md");
    expect(result).not.toContain("<code>");
  });

  it("does not double-wrap already code-formatted content", () => {
    const result = renderTelegramHtmlText("Already `wrapped.md` here");
    // Should have code tags but not nested
    expect(result).toContain("<code>");
    expect(result).not.toContain("<code><code>");
  });
});

describe("markdownToTelegramHtml - file reference wrapping", () => {
  it("wraps file references by default", () => {
    const result = markdownToTelegramHtml("Check README.md");
    expect(result).toContain("<code>README.md</code>");
  });

  it("can skip wrapping when requested", () => {
    const result = markdownToTelegramHtml("Check README.md", { wrapFileRefs: false });
    expect(result).not.toContain("<code>README.md</code>");
  });

  it("wraps multiple file types in a single message", () => {
    const result = markdownToTelegramHtml("Edit main.go and script.py");
    expect(result).toContain("<code>main.go</code>");
    expect(result).toContain("<code>script.py</code>");
  });

  it("preserves real URLs as anchor tags", () => {
    const result = markdownToTelegramHtml("Visit https://example.com");
    expect(result).toContain('<a href="https://example.com">');
  });

  it("preserves explicit markdown links even when href looks like a file ref", () => {
    const result = markdownToTelegramHtml("[docs](http://README.md)");
    expect(result).toContain('<a href="http://README.md">docs</a>');
  });

  it("wraps file ref after real URL in same message", () => {
    const result = markdownToTelegramHtml("Visit https://example.com and README.md");
    expect(result).toContain('<a href="https://example.com">');
    expect(result).toContain("<code>README.md</code>");
  });
});

describe("markdownToTelegramChunks - file reference wrapping", () => {
  it("wraps file references in chunked output", () => {
    const chunks = markdownToTelegramChunks("Check README.md and backup.sh", 4096);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].html).toContain("<code>README.md</code>");
    expect(chunks[0].html).toContain("<code>backup.sh</code>");
  });
});

describe("edge cases", () => {
  it("wraps file refs inside emphasis tags", () => {
    const cases = [
      ["**README.md**", "<b><code>README.md</code></b>"],
      ["*script.py*", "<i><code>script.py</code></i>"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(markdownToTelegramHtml(input), input).toBe(expected);
    }
  });

  it("does not wrap inside fenced code blocks", () => {
    const result = markdownToTelegramHtml("```\nREADME.md\n```");
    expect(result).toBe("<pre><code>README.md\n</code></pre>");
    expect(result).not.toContain("<code><code>");
  });

  it("preserves real URL/domain paths as anchors", () => {
    const cases = [
      {
        input: "example.com/README.md",
        href: 'href="http://example.com/README.md"',
      },
      {
        input: "https://github.com/foo/README.md",
        href: 'href="https://github.com/foo/README.md"',
      },
    ] as const;
    for (const testCase of cases) {
      const result = markdownToTelegramHtml(testCase.input);
      expect(result).toContain(`<a ${testCase.href}>`);
      expect(result).not.toContain("<code>");
    }
  });

  it("handles wrapFileRefs: false (plain text output)", () => {
    const result = markdownToTelegramHtml("README.md", { wrapFileRefs: false });
    // buildTelegramLink returns null, so no <a> tag; wrapFileRefs: false skips <code>
    expect(result).toBe("README.md");
  });

  it("wraps supported TLD extensions (.am, .at, .be, .cc)", () => {
    const result = markdownToTelegramHtml("Makefile.am and code.at and app.be and main.cc");
    expect(result).toContain("<code>Makefile.am</code>");
    expect(result).toContain("<code>code.at</code>");
    expect(result).toContain("<code>app.be</code>");
    expect(result).toContain("<code>main.cc</code>");
  });

  it("does not wrap popular domain TLDs (.ai, .io, .tv, .fm)", () => {
    // These are commonly used as real domains (x.ai, vercel.io, github.io)
    const result = markdownToTelegramHtml("Check x.ai and vercel.io and app.tv and radio.fm");
    // Should be links, not code
    expect(result).toContain('<a href="http://x.ai">');
    expect(result).toContain('<a href="http://vercel.io">');
    expect(result).toContain('<a href="http://app.tv">');
    expect(result).toContain('<a href="http://radio.fm">');
  });

  it("keeps .co domains as links", () => {
    const result = markdownToTelegramHtml("Visit t.co and openclaw.co");
    expect(result).toContain('<a href="http://t.co">');
    expect(result).toContain('<a href="http://openclaw.co">');
    expect(result).not.toContain("<code>t.co</code>");
    expect(result).not.toContain("<code>openclaw.co</code>");
  });

  it("does not wrap non-TLD extensions", () => {
    const result = markdownToTelegramHtml("image.png and style.css and script.js");
    expect(result).not.toContain("<code>image.png</code>");
    expect(result).not.toContain("<code>style.css</code>");
    expect(result).not.toContain("<code>script.js</code>");
  });

  it("handles file refs at message boundaries", () => {
    const cases = [
      ["README.md is important", "<code>README.md</code> is important"],
      ["Check the README.md", "Check the <code>README.md</code>"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(markdownToTelegramHtml(input), input).toBe(expected);
    }
  });

  it("handles multiple file refs in sequence", () => {
    const result = markdownToTelegramHtml("README.md CHANGELOG.md LICENSE.md");
    expect(result).toContain("<code>README.md</code>");
    expect(result).toContain("<code>CHANGELOG.md</code>");
    expect(result).toContain("<code>LICENSE.md</code>");
  });

  it("handles nested path without domain-like segments", () => {
    const result = markdownToTelegramHtml("src/utils/helpers/format.go");
    expect(result).toContain("<code>src/utils/helpers/format.go</code>");
  });

  it("wraps path with version-like segment (not a domain)", () => {
    // v1.0/README.md is not linkified by markdown-it (no TLD), so it's wrapped
    const result = markdownToTelegramHtml("v1.0/README.md");
    expect(result).toContain("<code>v1.0/README.md</code>");
  });

  it("preserves domain path with version segment", () => {
    // example.com/v1.0/README.md IS linkified (has domain), preserved as link
    const result = markdownToTelegramHtml("example.com/v1.0/README.md");
    expect(result).toContain('<a href="http://example.com/v1.0/README.md">');
  });

  it("wraps hyphen/underscore filenames and uppercase extensions", () => {
    const first = markdownToTelegramHtml("my-file_name.md");
    expect(first).toContain("<code>my-file_name.md</code>");

    const second = markdownToTelegramHtml("README.MD and SCRIPT.PY");
    expect(second).toContain("<code>README.MD</code>");
    expect(second).toContain("<code>SCRIPT.PY</code>");
  });

  it("handles nested code tags (depth tracking)", () => {
    // Nested <code> inside <pre> - should not wrap inner content
    const input = "<pre><code>README.md</code></pre> then script.py";
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe("<pre><code>README.md</code></pre> then <code>script.py</code>");
  });

  it("handles multiple anchor tags in sequence", () => {
    const input =
      '<a href="https://a.com">link1</a> README.md <a href="https://b.com">link2</a> script.py';
    const result = wrapFileReferencesInHtml(input);
    expect(result).toContain("</a> <code>README.md</code> <a");
    expect(result).toContain("</a> <code>script.py</code>");
  });

  it("wraps orphaned TLD pattern after special character", () => {
    // R&D.md - the & breaks the main pattern, but D.md could be auto-linked
    // So we wrap the orphaned D.md part to prevent Telegram linking it
    const input = "R&D.md";
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe("R&<code>D.md</code>");
  });

  it("wraps orphaned single-letter TLD patterns", () => {
    // Use extensions still in the set (md, sh, py, go)
    const result1 = wrapFileReferencesInHtml("X.md is cool");
    expect(result1).toContain("<code>X.md</code>");

    const result2 = wrapFileReferencesInHtml("Check R.sh");
    expect(result2).toContain("<code>R.sh</code>");
  });

  it("does not match filenames containing angle brackets", () => {
    // The regex character class [a-zA-Z0-9_.\\-./] doesn't include < >
    // so these won't be matched and wrapped (which is correct/safe)
    const input = "file<script>.md";
    const result = wrapFileReferencesInHtml(input);
    // Not wrapped because < breaks the filename pattern
    expect(result).toBe(input);
  });

  it("wraps file ref before unrelated HTML tags", () => {
    // x.md followed by unrelated closing tag and bold - wrap the file ref only
    const input = "x.md <b>bold</b>";
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe("<code>x.md</code> <b>bold</b>");
  });

  it("does not wrap orphaned TLD inside existing code tags", () => {
    // R&D.md is already inside <code>, orphaned pass should NOT wrap D.md again
    const input = "<code>R&D.md</code>";
    const result = wrapFileReferencesInHtml(input);
    // Should remain unchanged - no nested code tags
    expect(result).toBe(input);
    expect(result).not.toContain("<code><code>");
    expect(result).not.toContain("</code></code>");
  });

  it("does not wrap orphaned TLD inside anchor link text", () => {
    // R&D.md inside anchor text should NOT have D.md wrapped
    const input = '<a href="https://example.com">R&D.md</a>';
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe(input);
    expect(result).not.toContain("<code>D.md</code>");
  });

  it("handles malformed HTML with stray closing tags (negative depth)", () => {
    // Stray </code> before content shouldn't break protection logic
    // (depth should clamp at 0, not go negative)
    const input = "</code>README.md<code>inside</code> after.md";
    const result = wrapFileReferencesInHtml(input);
    // README.md should be wrapped (codeDepth = 0 after clamping stray close)
    expect(result).toContain("<code>README.md</code>");
    // after.md should be wrapped (codeDepth = 0 after proper close)
    expect(result).toContain("<code>after.md</code>");
    // Should not have nested code tags
    expect(result).not.toContain("<code><code>");
  });

  it("does not wrap orphaned TLD fragments inside HTML attributes", () => {
    const cases = [
      '<a href="http://example.com/R&D.md">link</a>',
      '<img src="logo/R&D.md" alt="R&D.md">',
    ] as const;
    for (const input of cases) {
      const result = wrapFileReferencesInHtml(input);
      expect(result).toBe(input);
      expect(result).not.toContain("<code>D.md</code>");
    }
  });

  it("handles multiple orphaned TLDs with HTML tags (offset stability)", () => {
    // This tests the bug where offset is relative to pre-replacement string
    // but we were checking against the mutating result string
    const input = '<a href="http://A.md">link</a> B.md <span title="C.sh">text</span> D.py';
    const result = wrapFileReferencesInHtml(input);
    // A.md in href should NOT be wrapped (inside attribute)
    // B.md outside tags SHOULD be wrapped
    // C.sh in title attribute should NOT be wrapped
    // D.py outside tags SHOULD be wrapped
    expect(result).toContain("<code>B.md</code>");
    expect(result).toContain("<code>D.py</code>");
    expect(result).not.toContain("<code>A.md</code>");
    expect(result).not.toContain("<code>C.sh</code>");
    // Attributes should be unchanged
    expect(result).toContain('href="http://A.md"');
    expect(result).toContain('title="C.sh"');
  });
});
