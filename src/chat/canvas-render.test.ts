// Canvas-render tests cover [embed] shortcode extraction and text stripping.
import { describe, expect, it } from "vitest";
import { extractCanvasShortcodes, parseCanvasAttributes } from "./canvas-render.ts";

describe("extractCanvasShortcodes", () => {
  it("does not let a self-closing embed start a greedy block match", () => {
    // Regression: the block regex used to greedily swallow the span from a
    // self-closing "[embed ... /]" open tag up to a later stray "[/embed]",
    // deleting the visible text in between (" keep me ") from channel delivery.
    const input = '[embed url="https://a.com" /] keep me [/embed]';
    const { text, previews } = extractCanvasShortcodes(input);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.url).toBe("https://a.com");
    // The visible text between the self-closing embed and the stray close
    // marker must be preserved, not silently stripped.
    expect(text).toContain("keep me");
    expect(text).toBe("keep me [/embed]");
  });

  it("still extracts a normal block embed and strips only the shortcode span", () => {
    const input = 'before [embed ref="doc1"] hi [/embed] after';
    const { text, previews } = extractCanvasShortcodes(input);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.viewId).toBe("doc1");
    expect(text).toBe("before  after");
  });

  it("still extracts a plain self-closing embed and keeps surrounding text", () => {
    const input = 'see [embed url="https://b.com" /] end';
    const { text, previews } = extractCanvasShortcodes(input);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.url).toBe("https://b.com");
    expect(text).toBe("see  end");
  });
});

describe("parseCanvasAttributes security", () => {
  describe("ReDoS protection", () => {
    it("handles malicious input with many whitespace characters without catastrophic backtracking", () => {
      // ReDoS payload: many whitespace chars followed by unclosed quote
      const maliciousInput = "a".repeat(100) + '="'.repeat(50);
      const start = performance.now();
      const result = parseCanvasAttributes(maliciousInput);
      const duration = performance.now() - start;

      // Should complete in reasonable time (< 100ms)
      // Catastrophic backtracking would take seconds or minutes
      expect(duration).toBeLessThan(100);
      expect(result).toBeTypeOf("object");
    });

    it("handles very long unclosed attribute strings efficiently", () => {
      // Another ReDoS pattern: long attribute name without closing quote
      const maliciousInput = 'url="https://safe.com" ' + "a".repeat(500) + '="';
      const start = performance.now();
      const result = parseCanvasAttributes(maliciousInput);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(100);
      // Should still parse the valid attribute before the malicious part
      expect(result.url).toBe("https://safe.com");
    });

    it("rejects input exceeding maximum length limit", () => {
      // Create input exceeding 10KB limit
      const longInput = 'url="valid" ' + "a".repeat(10240);
      const result = parseCanvasAttributes(longInput);

      // Should return empty object or only safe parsed attributes
      expect(Object.keys(result).length).toBeLessThanOrEqual(1);
    });
  });

  describe("XSS protection", () => {
    it("blocks javascript: protocol URLs", () => {
      const input = 'url="javascript:alert(document.cookie)"';
      const result = parseCanvasAttributes(input);

      // Dangerous protocol should be blocked
      expect(result.url).toBeUndefined();
    });

    it("blocks data: protocol URLs with text/html", () => {
      const input = 'url="data:text/html,<script>alert(1)</script>"';
      const result = parseCanvasAttributes(input);

      // Dangerous data URL should be blocked
      expect(result.url).toBeUndefined();
    });

    it("blocks vbscript: protocol URLs", () => {
      const input = 'url="vbscript:msgbox(1)"';
      const result = parseCanvasAttributes(input);

      expect(result.url).toBeUndefined();
    });

    it("blocks event handler attributes", () => {
      const input = 'onclick="alert(1)" onmouseover="alert(2)" onload="alert(3)"';
      const result = parseCanvasAttributes(input);

      // Event handlers should be blocked
      expect(result.onclick).toBeUndefined();
      expect(result.onmouseover).toBeUndefined();
      expect(result.onload).toBeUndefined();
    });

    it("allows safe http/https URLs", () => {
      const input = 'url="https://example.com/path?query=value"';
      const result = parseCanvasAttributes(input);

      expect(result.url).toBe("https://example.com/path?query=value");
    });

    it("allows safe data: URLs for images", () => {
      const input =
        'url="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="';
      const result = parseCanvasAttributes(input);

      // Safe image data URLs should be allowed
      expect(result.url).toContain("data:image/");
    });

    it("handles mixed safe and unsafe attributes", () => {
      const input = 'url="https://safe.com" onclick="alert(1)" ref="doc1" onerror="alert(2)"';
      const result = parseCanvasAttributes(input);

      // Safe attributes should be preserved
      expect(result.url).toBe("https://safe.com");
      expect(result.ref).toBe("doc1");
      // Unsafe attributes should be blocked
      expect(result.onclick).toBeUndefined();
      expect(result.onerror).toBeUndefined();
    });

    it("blocks javascript: with whitespace obfuscation", () => {
      const input = 'url="  javascript  :  alert(1)"';
      const result = parseCanvasAttributes(input);

      // Obfuscated javascript: should still be blocked
      expect(result.url).toBeUndefined();
    });

    it("blocks javascript: with HTML entity encoding", () => {
      const input = 'url="&#106;avascript:alert(1)"';
      const result = parseCanvasAttributes(input);

      // HTML entity encoded javascript: should be blocked
      expect(result.url).toBeUndefined();
    });
  });

  describe("normal operation", () => {
    it("parses valid attributes correctly", () => {
      const input = 'url="https://example.com" ref="doc123" title="My Document"';
      const result = parseCanvasAttributes(input);

      expect(result.url).toBe("https://example.com");
      expect(result.ref).toBe("doc123");
      expect(result.title).toBe("My Document");
    });

    it("handles single quotes around attribute values", () => {
      const input = "url='https://example.com' ref='doc123'";
      const result = parseCanvasAttributes(input);

      expect(result.url).toBe("https://example.com");
      expect(result.ref).toBe("doc123");
    });

    it("handles attributes with underscores and hyphens", () => {
      const input = 'data_id="123" class_name="my-class" preferred_height="400"';
      const result = parseCanvasAttributes(input);

      expect(result.data_id).toBe("123");
      expect(result.class_name).toBe("my-class");
      expect(result.preferred_height).toBe("400");
    });

    it("returns empty object for empty input", () => {
      const result = parseCanvasAttributes("");
      expect(result).toEqual({});
    });

    it("returns empty object for input with no valid attributes", () => {
      const result = parseCanvasAttributes("no valid attributes here");
      expect(result).toEqual({});
    });
  });
});
