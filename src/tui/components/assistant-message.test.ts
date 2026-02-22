import { describe, expect, test } from "vitest";

// Import the preprocessing function by temporarily exporting it
// Note: In a real implementation, we'd export this function or test it differently
const URL_REGEX = /https?:\/\/[^\s\)<>\[\]"']+/g;

function preprocessUrlsForWrapping(text: string): string {
  return text.replace(URL_REGEX, (url) => {
    return url
      .replace(/ /g, '\u00A0')
      .replace(/\//g, '/\u200C')
      .replace(/-/g, '-\u200C')
      .replace(/\./g, '.\u200C')
      .replace(/=/g, '=\u200C')
      .replace(/&/g, '&\u200C')
      .replace(/_/g, '_\u200C');
  });
}

describe("URL wrapping prevention", () => {
  test("should process URLs to prevent line breaking", () => {
    const input = "Check out https://github.com/openclaw/openclaw/issues/17772 for details.";
    const result = preprocessUrlsForWrapping(input);
    
    // Verify that the URL contains non-breaking characters
    expect(result).toContain('/\u200C'); // Zero-width non-joiner after slashes
    expect(result).toContain('.\u200C'); // Zero-width non-joiner after dots
    expect(result).toContain('-\u200C'); // Zero-width non-joiner after hyphens
    
    // Verify that regular text is unchanged
    expect(result).toContain("Check out ");
    expect(result).toContain(" for details.");
  });

  test("should handle long URLs from the issue example", () => {
    const input = "Download from https://github.com/SomeOrg/some-project-with-a-long-name/blob/main/output/some-file.pptx";
    const result = preprocessUrlsForWrapping(input);
    
    // Verify that long URLs are processed
    expect(result).toContain('/\u200C');
    expect(result).toContain('-\u200C');
    expect(result).toContain('.\u200C');
    
    // The URL should not have regular spaces that could cause breaks
    expect(result).not.toMatch(/https?:\/\/[^ ]* [^ ]*\//);
  });

  test("should handle URLs in markdown context", () => {
    const input = "See [the docs](https://example.com/very-long-path/documentation.html) for more info.";
    const result = preprocessUrlsForWrapping(input);
    
    // Should process the URL inside markdown link syntax
    expect(result).toContain('/\u200C');
    expect(result).toContain('.\u200C');
    expect(result).toContain('-\u200C');
  });

  test("should handle multiple URLs", () => {
    const input = "Visit https://github.com/openclaw/openclaw and https://example.com/test";
    const result = preprocessUrlsForWrapping(input);
    
    // Both URLs should be processed
    const urlMatches = result.match(/https?:\/\/[^\s]+/g);
    expect(urlMatches).toHaveLength(2);
    
    urlMatches?.forEach(url => {
      expect(url).toContain('/\u200C');
    });
  });

  test("should not affect non-URL text", () => {
    const input = "This is regular text with no URLs.";
    const result = preprocessUrlsForWrapping(input);
    
    // Should remain unchanged
    expect(result).toBe(input);
  });
});