import { describe, expect, test } from "vitest";
import { sanitizeEmotionTagsForMode, stripEmotionTags } from "./emotion-tags.js";

describe("stripEmotionTags", () => {
  test("does not strip inline directive tags", () => {
    const onlyDirective = stripEmotionTags("[[audio_as_voice]]");
    const mixed = stripEmotionTags("[[audio_as_voice]] [warmly] hello");

    expect(onlyDirective).toEqual({ text: "[[audio_as_voice]]", changed: false });
    expect(mixed).toEqual({ text: "[[audio_as_voice]] hello", changed: true });
  });

  test("does not strip bracketed technical content", () => {
    const regex = stripEmotionTags("Use [A-Z] in the regex");
    const version = stripEmotionTags("Look for [v1.2] in the changelog");

    expect(regex).toEqual({ text: "Use [A-Z] in the regex", changed: false });
    expect(version).toEqual({ text: "Look for [v1.2] in the changelog", changed: false });
  });

  test("strips uppercase emotion tags while preserving bracketed technical content", () => {
    const uppercase = stripEmotionTags("[Warmly] hello there");
    const technical = stripEmotionTags("Keep [SOFTLY_TYPED] as a literal token");
    const spacedLink = stripEmotionTags("[Warmly] (https://example.test)");

    expect(uppercase).toEqual({ text: "hello there", changed: true });
    expect(technical).toEqual({
      text: "Keep [SOFTLY_TYPED] as a literal token",
      changed: false,
    });
    expect(spacedLink).toEqual({
      text: "[Warmly] (https://example.test)",
      changed: false,
    });
  });

  test("preserves newlines after stripping a standalone emotion tag", () => {
    const result = stripEmotionTags("[warmly]\nHello there");

    expect(result).toEqual({ text: "\nHello there", changed: true });
  });

  test("does not leave a leading space after stripping adjacent emotion tags", () => {
    const result = stripEmotionTags("[warmly][softly] hello there");

    expect(result).toEqual({ text: "hello there", changed: true });
  });
});

describe("sanitizeEmotionTagsForMode", () => {
  test("hides trailing partial tags in full mode without removing complete tags", () => {
    const result = sanitizeEmotionTagsForMode("[warmly] hello [soft", "full", {
      allowTrailingPartialTag: true,
    });

    expect(result).toEqual({ text: "[warmly] hello ", changed: true });
  });

  test("hides a bare trailing bracket during streaming", () => {
    const result = sanitizeEmotionTagsForMode("hello [", "on", {
      allowTrailingPartialTag: true,
    });

    expect(result).toEqual({ text: "hello ", changed: true });
  });

  test("does not strip trailing partial tags inside inline code", () => {
    const result = sanitizeEmotionTagsForMode("Use `[soft` in the example", "on", {
      allowTrailingPartialTag: true,
    });

    expect(result).toEqual({ text: "Use `[soft` in the example", changed: false });
  });

  test("does not strip a trailing bracket inside fenced code", () => {
    const result = sanitizeEmotionTagsForMode("```ts\nconst items = [\n```", "full", {
      allowTrailingPartialTag: true,
    });

    expect(result).toEqual({ text: "```ts\nconst items = [\n```", changed: false });
  });

  test("leaves text unchanged when emotion mode is unspecified", () => {
    const result = sanitizeEmotionTagsForMode("hello [soft", undefined, {
      allowTrailingPartialTag: true,
    });

    expect(result).toEqual({ text: "hello [soft", changed: false });
  });
});
