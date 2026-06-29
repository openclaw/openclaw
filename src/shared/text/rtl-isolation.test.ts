import { describe, expect, it } from "vitest";
import { RTL_ISOLATION_MARKERS, RTL_ISOLATION_REGEX, applyRtlIsolation } from "./rtl-isolation.js";

const { start: RLI, end: PDI } = RTL_ISOLATION_MARKERS;

describe("applyRtlIsolation", () => {
  it("returns input unchanged when no RTL-script characters are present", () => {
    expect(applyRtlIsolation("Hello, world!")).toBe("Hello, world!");
  });

  it("wraps a single Hebrew line so trailing LTR punctuation stays on the visual right", () => {
    const input = "שלום?";
    const expected = `${RLI}${input}${PDI}`;
    expect(applyRtlIsolation(input)).toBe(expected);
  });

  it("wraps Arabic lines line-by-line and leaves LTR-only lines untouched", () => {
    const input = ["مرحبا!", "English line.", "كيف حالك؟"].join("\n");
    const expected = [`${RLI}مرحبا!${PDI}`, "English line.", `${RLI}كيف حالك؟${PDI}`].join("\n");
    expect(applyRtlIsolation(input)).toBe(expected);
  });

  it("leaves RTL text inside fenced code blocks unchanged", () => {
    const input = ["Before", "```text", "שלום?", "```", "After"].join("\n");
    expect(applyRtlIsolation(input)).toBe(input);
  });

  it("does not wrap lines where RTL text appears only inside inline code", () => {
    const input = "Use `שלום?` as the example.";
    expect(applyRtlIsolation(input)).toBe(input);
  });

  it("still wraps RTL prose lines that also contain inline code", () => {
    const input = "שלום `code`?";
    expect(applyRtlIsolation(input)).toBe(`${RLI}${input}${PDI}`);
  });

  it("is idempotent: re-wrapping already-isolated text is a no-op", () => {
    const input = "שלום?";
    const once = applyRtlIsolation(input);
    const twice = applyRtlIsolation(once);
    expect(twice).toBe(once);
  });

  it("skips lines that already contain bidi control characters", () => {
    const lineWithEmbed = `\u202aforced ltr שלום\u202c`;
    expect(applyRtlIsolation(lineWithEmbed)).toBe(lineWithEmbed);
  });

  it("exposes the underlying regex and marker constants for downstream guards", () => {
    expect(RTL_ISOLATION_REGEX.rtlScript.test("שלום")).toBe(true);
    expect(RTL_ISOLATION_REGEX.bidiControl.test(RLI)).toBe(true);
    expect(RLI).toBe("\u2067");
    expect(PDI).toBe("\u2069");
  });
});
