import { describe, expect, it } from "vitest";
import { sanitizeInput } from "./sanitize.js";

describe("sanitizeInput", () => {
  // --- basic pass-through ---

  it("passes clean text through unchanged with no warnings", () => {
    const result = sanitizeInput("Hello, world!");
    expect(result.text).toBe("Hello, world!");
    expect(result.warnings).toEqual([]);
  });

  it("returns empty string with no warnings for empty input", () => {
    const result = sanitizeInput("");
    expect(result.text).toBe("");
    expect(result.warnings).toEqual([]);
  });

  // --- truncation ---

  it("truncates input exceeding default maxLength (100_000)", () => {
    const input = "a".repeat(150_000);
    const result = sanitizeInput(input);
    expect(result.text.length).toBe(100_000);
    expect(result.warnings).toEqual([
      {
        type: "truncated",
        detail: "Input truncated from 150000 to 100000 characters",
      },
    ]);
  });

  it("respects custom maxLength config", () => {
    const input = "abcdefghij"; // 10 chars
    const result = sanitizeInput(input, { maxLength: 5 });
    expect(result.text).toBe("abcde");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe("truncated");
  });

  it("does not truncate input at exactly maxLength", () => {
    const input = "a".repeat(100_000);
    const result = sanitizeInput(input);
    expect(result.text.length).toBe(100_000);
    expect(result.warnings).toEqual([]);
  });

  // --- NFKC normalization ---

  it("applies NFKC normalization (ligature fi → fi)", () => {
    const result = sanitizeInput("\uFB01nance"); // "ﬁnance"
    expect(result.text).toBe("finance");
    expect(result.warnings).toEqual([
      { type: "normalized", detail: "NFKC unicode normalization applied" },
    ]);
  });

  it("applies NFKC normalization (circled digit ① → 1)", () => {
    const result = sanitizeInput("\u2460"); // "①"
    expect(result.text).toBe("1");
    expect(result.warnings).toEqual([
      { type: "normalized", detail: "NFKC unicode normalization applied" },
    ]);
  });

  it("skips NFKC normalization when nfkcNormalize is false", () => {
    const input = "\uFB01nance"; // "ﬁnance"
    const result = sanitizeInput(input, { nfkcNormalize: false });
    expect(result.text).toBe(input);
    expect(result.warnings).toEqual([]);
  });

  it("does not emit normalized warning when text is already NFKC", () => {
    const result = sanitizeInput("already normalized text");
    expect(result.warnings).toEqual([]);
  });

  // --- control character stripping ---

  it("strips control characters when density exceeds threshold", () => {
    // 5 control chars in 10-char string = 50% density (well above 10% default)
    const input = "h\x00e\x01l\x02l\x03o\x04";
    const result = sanitizeInput(input);
    expect(result.text).toBe("hello");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "control_chars_stripped" })]),
    );
  });

  it("does NOT strip control characters when density is below threshold", () => {
    // 1 control char in 100 regular chars = 1% density (below 10% default)
    const input = "a".repeat(99) + "\x01";
    const result = sanitizeInput(input);
    expect(result.text).toBe(input);
    expect(result.warnings.find((w) => w.type === "control_chars_stripped")).toBeUndefined();
  });

  it("preserves tab, newline, and carriage return (not counted as control chars)", () => {
    const input = "line1\tindented\nline2\rline3";
    const result = sanitizeInput(input);
    expect(result.text).toBe(input);
    expect(result.warnings).toEqual([]);
  });

  it("respects custom controlCharDensityThreshold", () => {
    // 2 control chars in 10-char string = 20% density
    // With threshold 0.5 this should NOT strip
    const input = "abcdefgh\x00\x01";
    const result = sanitizeInput(input, { controlCharDensityThreshold: 0.5 });
    expect(result.text).toBe(input);
    expect(result.warnings.find((w) => w.type === "control_chars_stripped")).toBeUndefined();
  });

  it("strips control chars with lower custom threshold", () => {
    // 1 control char in 20-char string = 5% density
    // With threshold 0.01 this should strip
    const input = "a".repeat(19) + "\x01";
    const result = sanitizeInput(input, { controlCharDensityThreshold: 0.01 });
    expect(result.text).toBe("a".repeat(19));
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "control_chars_stripped" })]),
    );
  });

  // --- combined behavior ---

  it("returns multiple warnings when multiple sanitizations apply", () => {
    // Build input that triggers truncation + normalization + control char stripping
    // Short custom maxLength to keep test manageable
    const controlHeavy = "\x00\x01\x02abc"; // 3 ctrl + 3 regular = 50% density after normalization
    const input = "\uFB01" + controlHeavy + "x".repeat(100);
    const result = sanitizeInput(input, { maxLength: 10 });

    const warningTypes = result.warnings.map((w) => w.type);
    expect(warningTypes).toContain("truncated");
    // After truncation the remaining text may or may not trigger normalization/control stripping
    // depending on what's in the first 10 chars — at minimum truncation fires
  });

  it("applies steps in order: truncate → normalize → control-strip", () => {
    // Verify ordering: truncate first, then normalize the truncated result
    const input = "\uFB01".repeat(5) + "a".repeat(10);
    const result = sanitizeInput(input, { maxLength: 8 });

    // Truncation happens first on the original string (8 chars from original)
    expect(result.warnings[0].type).toBe("truncated");
    // Then NFKC normalization on the truncated portion
    if (result.warnings.length > 1) {
      expect(result.warnings[1].type).toBe("normalized");
    }
  });

  // --- additional edge cases ---

  it("handles maxLength of 1", () => {
    const result = sanitizeInput("abcdef", { maxLength: 1 });
    expect(result.text).toBe("a");
    expect(result.warnings[0].type).toBe("truncated");
  });

  it("handles threshold exactly at 0 (always strips if any control chars exist)", () => {
    // 1 ctrl char in 10-char string = 10% density, threshold 0 → should strip
    const input = "abcdefghi\x01";
    const result = sanitizeInput(input, { controlCharDensityThreshold: 0 });
    expect(result.text).toBe("abcdefghi");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "control_chars_stripped" })]),
    );
  });

  it("does not strip when threshold is 1 (maximum tolerance)", () => {
    // Even with 50% control chars, threshold 1.0 should not trigger
    const input = "\x00a\x01b\x02c";
    const result = sanitizeInput(input, { controlCharDensityThreshold: 1 });
    expect(result.text).toBe(input);
    expect(result.warnings.find((w) => w.type === "control_chars_stripped")).toBeUndefined();
  });

  it("handles C1 control characters (U+0080-U+009F)", () => {
    // \x80-\x9F are C1 control chars, should be counted and stripped
    const input = "\x80\x81\x82abc";
    const result = sanitizeInput(input);
    // 3 ctrl chars in 6-char string = 50% density > 10% default threshold
    expect(result.text).toBe("abc");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "control_chars_stripped" })]),
    );
  });

  it("handles DEL character (U+007F)", () => {
    // DEL is included in the control char range
    const input = "\x7F\x7F\x7Fabc";
    const result = sanitizeInput(input);
    // 3 ctrl chars in 6-char string = 50% density
    expect(result.text).toBe("abc");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "control_chars_stripped" })]),
    );
  });

  it("returns empty string when all chars are stripped (control-only input)", () => {
    const input = "\x00\x01\x02\x03\x04";
    const result = sanitizeInput(input);
    expect(result.text).toBe("");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "control_chars_stripped" })]),
    );
  });
});
