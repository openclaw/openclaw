import { describe, expect, it } from "vitest";
import { stripBootEchoFromOutboundText } from "./boot-echo-guard.js";

const ECHO =
  "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
const BOOT_PROMPT = `BOOT.md:\n${ECHO.replaceAll(" ", "\n")}`;

describe("stripBootEchoFromOutboundText", () => {
  it.each([
    ["without a prompt", undefined, "anything goes", "anything goes"],
    ["without a substantial echo", BOOT_PROMPT, "Good morning!", "Good morning!"],
    ["below the minimum length", "x".repeat(80), "x".repeat(79), "x".repeat(79)],
    ["after whitespace normalization", BOOT_PROMPT, ECHO, ""],
  ])("handles outbound text %s", (_name, bootPrompt, outbound, expected) => {
    expect(stripBootEchoFromOutboundText(outbound, bootPrompt)).toBe(expected);
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
    for (const text of [
      `${"x".repeat(79)}😀`,
      `😀${"x".repeat(77)}😁`,
      `${"x".repeat(79)}\ud83d`,
      `\ude00${"x".repeat(79)}`,
    ]) {
      expect(stripBootEchoFromOutboundText(text, text)).toBe("");
    }
  });

  it("keeps memory bounded for a boot prompt with more windows than a Set can hold", () => {
    // Random ASCII units exceed 2^24 candidate windows of 80 and 81 UTF-16 units.
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
