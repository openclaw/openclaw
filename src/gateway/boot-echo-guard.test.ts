// Boot echo guard tests protect session-scoped prompt tracking and outbound text
// stripping that prevents internal BOOT context from being sent back to users.
import { describe, expect, it } from "vitest";
import { stripBootEchoFromOutboundText } from "./boot-echo-guard.js";

const LONG_BOOT_PROMPT = [
  "You are running a boot check. Follow BOOT.md instructions exactly.",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "",
  "BOOT.md:",
  "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel and report the active project status with three concrete bullet points.",
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
].join("\n");

describe("stripBootEchoFromOutboundText", () => {
  it("returns the original text when no boot prompt is registered", () => {
    expect(stripBootEchoFromOutboundText("anything goes", undefined)).toBe("anything goes");
  });

  it("returns the original text when outbound text does not contain a substantial echo", () => {
    expect(stripBootEchoFromOutboundText("Good morning!", LONG_BOOT_PROMPT)).toBe("Good morning!");
  });

  it("collapses outbound text to empty when it substantially echoes the boot prompt", () => {
    const echoed = `My instructions were: ${LONG_BOOT_PROMPT}`;
    expect(stripBootEchoFromOutboundText(echoed, LONG_BOOT_PROMPT)).toBe("");
  });

  it("detects copied boot content after whitespace normalization", () => {
    const bootPrompt = [
      "BOOT.md:",
      "When you wake up each morning,",
      "send a thoughtful greeting to the operator",
      "over the configured channel and report status.",
    ].join("\n");
    const outbound =
      "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";

    expect(stripBootEchoFromOutboundText(outbound, bootPrompt)).toBe("");
  });

  it("detects an unaligned exact minimum-length boot prompt chunk", () => {
    const bootPrompt = Array.from({ length: 120 }, (_, index) =>
      index.toString(36).padStart(2, "0"),
    ).join(":");
    const unalignedChunk = bootPrompt.slice(1, 81);

    expect(unalignedChunk).toHaveLength(80);
    expect(stripBootEchoFromOutboundText(unalignedChunk, bootPrompt)).toBe("");
  });

  it("detects a substantial chunk at the boot prompt tail", () => {
    const tail = LONG_BOOT_PROMPT.slice(-90, -5);

    expect(tail.length).toBeGreaterThan(80);
    expect(stripBootEchoFromOutboundText(tail, LONG_BOOT_PROMPT)).toBe("");
  });

  it("does not produce false positives on surrogate boundary windows", () => {
    // Regression: when a boot prompt contains non-BMP characters at
    // positions that cause the 80-char sliding window to cross surrogate
    // pair boundaries, sliceUtf16Safe expands the window to include the
    // full pair.  The expanded window is longer than minLen but must not
    // cause false-positive echo detection against outbound text that
    // shares only the prefix.
    const prefix = "x".repeat(79);
    const emoji = "\u{1F600}"; // 😀 — 2 UTF-16 code units
    const bootPrompt = prefix + emoji + "y".repeat(20);

    // Outbound text shares the 79-char prefix but not 80 contiguous chars
    const outbound = prefix + " (safe continuation)";
    expect(stripBootEchoFromOutboundText(outbound, bootPrompt)).toBe(outbound);
  });

  it("correctly detects echoes with non-BMP characters", () => {
    // Non-BMP characters in the shared substring must still be detected
    const emoji = "\u{1F600}"; // 😀
    const bootPrompt = "A".repeat(40) + emoji + "A".repeat(40); // 82 code units
    // Outbound text containing a full 80-char+ contiguous substring
    const outbound = "prefix: " + "A".repeat(40) + emoji + "A".repeat(39);
    expect(stripBootEchoFromOutboundText(outbound, bootPrompt)).toBe("");
  });

  it("handles outbound text ending at a low-surrogate boundary", () => {
    // Terminal low-surrogate regression: the last window in the haystack
    // should not crash or produce false positives when it ends at a
    // surrogate pair boundary.
    const bootPrompt = "A".repeat(100);
    const emoji = "\u{1F600}"; // 😀
    const outbound = "A".repeat(79) + emoji; // 81 code units, < 80 A's shared
    expect(stripBootEchoFromOutboundText(outbound, bootPrompt)).toBe(outbound);
  });
});
