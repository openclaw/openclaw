import { describe, it, expect } from "vitest";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

describe("WebSocket delta corruption regression", () => {
  it("should trim leading whitespace after stripping inline directive tags", () => {
    const textWithDirective = "[[reply_to_current]] Domain www.6.xumum.xyz";
    
    const result = stripInlineDirectiveTagsForDisplay(textWithDirective).text.trim();
    
    expect(result).toBe("Domain www.6.xumum.xyz");
    expect(result[0]).not.toBe(" ");
  });

  it("should handle audio_as_voice tag with trim", () => {
    const textWithDirective = "[[audio_as_voice]] Hello GOOGLE";
    
    const result = stripInlineDirectiveTagsForDisplay(textWithDirective).text.trim();
    
    expect(result).toBe("Hello GOOGLE");
    expect(result[0]).not.toBe(" ");
  });

  it("should handle multiple directive tags with trim", () => {
    const textWithDirectives = "[[reply_to_current]][[audio_as_voice]] Test www.example.com";
    
    const result = stripInlineDirectiveTagsForDisplay(textWithDirectives).text.trim();
    
    expect(result).toBe("Test www.example.com");
    expect(result[0]).not.toBe(" ");
  });

  it("should not break when no directive tags present", () => {
    const plainText = "Plain text without tags";
    
    const result = stripInlineDirectiveTagsForDisplay(plainText).text.trim();
    
    expect(result).toBe("Plain text without tags");
  });

  it("should handle delta parameter with trim", () => {
    const deltaWithDirective = "[[reply_to_current]] um.xyz";
    
    const result = stripInlineDirectiveTagsForDisplay(deltaWithDirective).text.trim();
    
    expect(result).toBe("um.xyz");
    expect(result[0]).not.toBe(" ");
  });
});
