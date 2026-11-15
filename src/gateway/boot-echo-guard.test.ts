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

  it("preserves 600 distinct surrogate-half collisions but suppresses identical echoes", () => {
    for (let index = 0; index < 600; index += 1) {
      const codePoint = 0x1f600 + (index % 64);
      const sharedHigh = index < 300;
      const prefix = sharedHigh ? "x".repeat(79) : "";
      const suffix = sharedHigh ? "" : "x".repeat(79);
      const bootPrompt = `${prefix}${String.fromCodePoint(codePoint)}${suffix}boot`;
      const outbound = `${prefix}${String.fromCodePoint(codePoint + (sharedHigh ? 64 : 0x400))}${suffix}visible`;

      expect(stripBootEchoFromOutboundText(outbound, bootPrompt)).toBe(outbound);
    }
    for (const text of [`${"x".repeat(79)}😀`, `😀${"x".repeat(77)}😁`]) {
      expect(stripBootEchoFromOutboundText(text, text)).toBe("");
    }
  });

  it("keeps memory bounded for a boot prompt with more windows than a Set can hold", () => {
    // 8,388,700 distinct characters have more than 2^24 windows of 80 and 81 characters.
    const bytes = new Uint8Array(8_388_700);
    let state = 1;
    for (let index = 0; index < bytes.length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
      bytes[index] = 97 + ((state >>> 24) % 26);
    }
    const bootPrompt = new TextDecoder().decode(bytes);
    const echo = `Report: ${bootPrompt.slice(-200, -100)}`;
    const heapBefore = process.memoryUsage().heapUsed;

    expect(stripBootEchoFromOutboundText(echo, bootPrompt)).toBe("");
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(64 * 2 ** 20);
    expect(stripBootEchoFromOutboundText("x".repeat(120), bootPrompt)).toBe("x".repeat(120));
  });
});
