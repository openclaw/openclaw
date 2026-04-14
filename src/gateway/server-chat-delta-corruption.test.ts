import { describe, it, expect } from "vitest";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { resolveMergedAssistantText } from "./server-chat.js";

describe("WebSocket delta corruption regression", () => {
  describe("emitChatDelta with inline directive tags", () => {
    it("trims leading whitespace from cleanedText after stripping directive tags", () => {
      const text = "[[reply_to_current]] Domain www.6.xumum.xyz";
      const delta = "[[reply_to_current]] Domain www.6.xumum.xyz";

      const cleanedText = stripInlineDirectiveTagsForDisplay(text).text.trimStart();
      const cleanedDelta = stripInlineDirectiveTagsForDisplay(delta).text;

      const mergedRawText = resolveMergedAssistantText({
        previousText: "",
        nextText: cleanedText,
        nextDelta: cleanedDelta,
      });

      expect(cleanedText).toBe("Domain www.6.xumum.xyz");
      expect(cleanedText[0]).not.toBe(" ");
      expect(cleanedDelta).toBe(" Domain www.6.xumum.xyz");
      expect(mergedRawText).toBe("Domain www.6.xumum.xyz");
    });

    it("preserves trailing spaces in delta when stripping directive tags", () => {
      const text = "Hello [[reply_to_current]] world [[audio_as_voice]]";
      const delta = "Hello [[reply_to_current]] world [[audio_as_voice]]";

      const cleanedText = stripInlineDirectiveTagsForDisplay(text).text.trimStart();
      const cleanedDelta = stripInlineDirectiveTagsForDisplay(delta).text;

      const mergedRawText = resolveMergedAssistantText({
        previousText: "",
        nextText: cleanedText,
        nextDelta: cleanedDelta,
      });

      expect(cleanedText).toBe("Hello  world ");
      expect(cleanedDelta).toBe("Hello  world ");
      expect(mergedRawText).toBe("Hello  world ");
    });

    it("preserves newlines in delta for segmented text", () => {
      const text1 = "Before tool call";
      const delta1 = "Before tool call";
      const cleanedText1 = stripInlineDirectiveTagsForDisplay(text1).text.trimStart();
      const cleanedDelta1 = stripInlineDirectiveTagsForDisplay(delta1).text;

      const merged1 = resolveMergedAssistantText({
        previousText: "",
        nextText: cleanedText1,
        nextDelta: cleanedDelta1,
      });

      const text2 = "After tool call";
      const delta2 = "\nAfter tool call";
      const cleanedText2 = stripInlineDirectiveTagsForDisplay(text2).text.trimStart();
      const cleanedDelta2 = stripInlineDirectiveTagsForDisplay(delta2).text;

      const merged2 = resolveMergedAssistantText({
        previousText: merged1 ?? "",
        nextText: cleanedText2,
        nextDelta: cleanedDelta2,
      });

      expect(cleanedDelta2).toBe("\nAfter tool call");
      expect(merged2).toBe("Before tool call\nAfter tool call");
    });

    it("does not truncate repeated character sequences", () => {
      const text = "[[reply_to_current]] GOOGLE";
      const delta = "[[reply_to_current]] GOOGLE";

      const cleanedText = stripInlineDirectiveTagsForDisplay(text).text.trimStart();
      const cleanedDelta = stripInlineDirectiveTagsForDisplay(delta).text;

      const mergedRawText = resolveMergedAssistantText({
        previousText: "",
        nextText: cleanedText,
        nextDelta: cleanedDelta,
      });

      expect(cleanedText).toBe("GOOGLE");
      expect(mergedRawText).toBe("GOOGLE");
    });

    it("preserves full domain names with repeated patterns", () => {
      const text = "[[reply_to_current]] Domain www.6.xumum.xyz";
      const delta = "[[reply_to_current]] Domain www.6.xumum.xyz";

      const cleanedText = stripInlineDirectiveTagsForDisplay(text).text.trimStart();
      const cleanedDelta = stripInlineDirectiveTagsForDisplay(delta).text;

      const mergedRawText = resolveMergedAssistantText({
        previousText: "",
        nextText: cleanedText,
        nextDelta: cleanedDelta,
      });

      expect(mergedRawText).toBe("Domain www.6.xumum.xyz");
      expect(mergedRawText).toContain("xumum");
    });
  });

  describe("resolveMergedAssistantText prefix detection", () => {
    it("uses nextText when it starts with previousText", () => {
      const result = resolveMergedAssistantText({
        previousText: "Hello",
        nextText: "Hello world",
        nextDelta: "",
      });

      expect(result).toBe("Hello world");
    });

    it("uses nextDelta when startsWith check fails and previousText is non-empty", () => {
      const result = resolveMergedAssistantText({
        previousText: "Hello",
        nextText: "World",
        nextDelta: " World",
      });

      expect(result).toBe("Hello World");
    });

    it("prefers nextText over nextDelta when previousText is empty", () => {
      const result = resolveMergedAssistantText({
        previousText: "",
        nextText: "Trimmed text",
        nextDelta: " Untrimmed text",
      });

      expect(result).toBe("Trimmed text");
    });

    it("handles empty previousText with no nextDelta", () => {
      const result = resolveMergedAssistantText({
        previousText: "",
        nextText: "New text",
        nextDelta: "",
      });

      expect(result).toBe("New text");
    });
  });
});
