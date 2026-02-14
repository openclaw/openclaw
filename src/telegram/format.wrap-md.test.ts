import { describe, expect, it } from "vitest";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  wrapFileReferencesInHtml,
} from "./format.js";

describe("wrapFileReferencesInHtml", () => {
  it("wraps .md filenames in code tags", () => {
    expect(wrapFileReferencesInHtml("Check README.md")).toContain("Check <code>README.md</code>");
    expect(wrapFileReferencesInHtml("See HEARTBEAT.md for status")).toContain(
      "See <code>HEARTBEAT.md</code> for status",
    );
  });

  it("wraps .go filenames", () => {
    expect(wrapFileReferencesInHtml("Check main.go")).toContain("Check <code>main.go</code>");
  });

  it("wraps .py filenames", () => {
    expect(wrapFileReferencesInHtml("Run script.py")).toContain("Run <code>script.py</code>");
  });

  it("wraps .pl filenames", () => {
    expect(wrapFileReferencesInHtml("Check backup.pl")).toContain("Check <code>backup.pl</code>");
  });

  it("wraps .sh filenames", () => {
    expect(wrapFileReferencesInHtml("Run backup.sh")).toContain("Run <code>backup.sh</code>");
  });

  it("wraps file paths", () => {
    expect(wrapFileReferencesInHtml("Look at squad/friday/HEARTBEAT.md")).toContain(
      "Look at <code>squad/friday/HEARTBEAT.md</code>",
    );
  });

  it("does not wrap inside existing code tags", () => {
    const input = "Already <code>wrapped.md</code> here";
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe(input);
    expect(result).not.toContain("<code><code>");
  });

  it("does not wrap inside pre tags", () => {
    const input = "<pre><code>README.md</code></pre>";
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe(input);
  });

  it("does not wrap inside anchor tags", () => {
    const input = '<a href="README.md">Link</a>';
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe(input);
  });

  it("does not wrap file refs inside real URL anchor tags", () => {
    const input = 'Visit <a href="https://example.com/README.md">example.com/README.md</a>';
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe(input);
  });

  it("handles mixed content correctly", () => {
    const result = wrapFileReferencesInHtml("Check README.md and CONTRIBUTING.md");
    expect(result).toContain("<code>README.md</code>");
    expect(result).toContain("<code>CONTRIBUTING.md</code>");
  });

  it("handles edge cases", () => {
    expect(wrapFileReferencesInHtml("No markdown files here")).not.toContain("<code>");
    expect(wrapFileReferencesInHtml("File.md at start")).toContain("<code>File.md</code>");
    expect(wrapFileReferencesInHtml("Ends with file.md")).toContain("<code>file.md</code>");
  });

  it("wraps file refs with punctuation boundaries", () => {
    expect(wrapFileReferencesInHtml("See README.md.")).toContain("<code>README.md</code>.");
    expect(wrapFileReferencesInHtml("See README.md,")).toContain("<code>README.md</code>,");
    expect(wrapFileReferencesInHtml("(README.md)")).toContain("(<code>README.md</code>)");
    expect(wrapFileReferencesInHtml("README.md:")).toContain("<code>README.md</code>:");
  });

  it("de-linkifies auto-linkified file ref anchors", () => {
    const input = '<a href="http://README.md">README.md</a>';
    expect(wrapFileReferencesInHtml(input)).toBe("<code>README.md</code>");
  });

  it("de-linkifies auto-linkified path anchors", () => {
    const input = '<a href="http://squad/friday/HEARTBEAT.md">squad/friday/HEARTBEAT.md</a>';
    expect(wrapFileReferencesInHtml(input)).toBe("<code>squad/friday/HEARTBEAT.md</code>");
  });

  it("preserves explicit links where label differs from href", () => {
    const input = '<a href="http://README.md">click here</a>';
    expect(wrapFileReferencesInHtml(input)).toBe(input);
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
  it("wraps file ref inside bold tags", () => {
    const result = markdownToTelegramHtml("**README.md**");
    expect(result).toBe("<b><code>README.md</code></b>");
  });

  it("wraps file ref inside italic tags", () => {
    const result = markdownToTelegramHtml("*script.py*");
    expect(result).toBe("<i><code>script.py</code></i>");
  });

  it("does not wrap inside fenced code blocks", () => {
    const result = markdownToTelegramHtml("```\nREADME.md\n```");
    expect(result).toBe("<pre><code>README.md\n</code></pre>");
    expect(result).not.toContain("<code><code>");
  });

  it("preserves domain-like paths as anchor tags", () => {
    const result = markdownToTelegramHtml("example.com/README.md");
    expect(result).toContain('<a href="http://example.com/README.md">');
    expect(result).not.toContain("<code>");
  });

  it("preserves github URLs with file paths", () => {
    const result = markdownToTelegramHtml("https://github.com/foo/README.md");
    expect(result).toContain('<a href="https://github.com/foo/README.md">');
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

  it("handles file ref at start of message", () => {
    const result = markdownToTelegramHtml("README.md is important");
    expect(result).toBe("<code>README.md</code> is important");
  });

  it("handles file ref at end of message", () => {
    const result = markdownToTelegramHtml("Check the README.md");
    expect(result).toBe("Check the <code>README.md</code>");
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

  it("handles file ref with hyphen and underscore in name", () => {
    const result = markdownToTelegramHtml("my-file_name.md");
    expect(result).toContain("<code>my-file_name.md</code>");
  });

  it("handles uppercase extensions", () => {
    const result = markdownToTelegramHtml("README.MD and SCRIPT.PY");
    expect(result).toContain("<code>README.MD</code>");
    expect(result).toContain("<code>SCRIPT.PY</code>");
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

  it("handles auto-linked anchor with backreference match", () => {
    // The regex uses \1 backreference - href must equal label
    const input = '<a href="http://README.md">README.md</a>';
    expect(wrapFileReferencesInHtml(input)).toBe("<code>README.md</code>");
  });

  it("preserves anchor when href and label differ (no backreference match)", () => {
    // Different href and label - should NOT de-linkify
    const input = '<a href="http://other.md">README.md</a>';
    expect(wrapFileReferencesInHtml(input)).toBe(input);
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

  it("does not wrap orphaned TLD inside href attributes", () => {
    // D.md inside href should NOT be wrapped
    const input = '<a href="http://example.com/R&D.md">link</a>';
    const result = wrapFileReferencesInHtml(input);
    // href should be untouched
    expect(result).toBe(input);
    expect(result).not.toContain("<code>D.md</code>");
  });

  it("does not wrap orphaned TLD inside any HTML attribute", () => {
    const input = '<img src="logo/R&D.md" alt="R&D.md">';
    const result = wrapFileReferencesInHtml(input);
    expect(result).toBe(input);
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
