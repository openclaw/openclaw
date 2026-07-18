import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Tool Surface Live Bench tests cover manual repro argument parsing and
// UTF-16-safe LLM text truncation at the three bench dump sites.
import { describe, expect, it } from "vitest";
import { parseBenchArgs } from "../../scripts/repro/tool-surface-live-bench.ts";

describe("tool surface live bench repro", () => {
  it("parses provider, surface, and task selections", () => {
    expect(
      parseBenchArgs([
        "--providers=openai,google",
        "--surfaces=direct,code-mode",
        "--tasks=recovery",
      ]),
    ).toMatchObject({
      providers: ["openai", "google"],
      surfaces: ["direct", "code-mode"],
      taskIds: ["recovery"],
    });
  });

  it("rejects unknown selections and misspelled arguments", () => {
    expect(() => parseBenchArgs(["--providers=ollama"])).toThrow(
      "unknown --providers value: ollama",
    );
    expect(() => parseBenchArgs(["--surface=direct"])).toThrow(
      "unknown argument: --surface=direct",
    );
    expect(() => parseBenchArgs(["--model-openai=gpt-test"])).toThrow(
      "unknown argument: --model-openai=gpt-test",
    );
  });
});

// ---------------------------------------------------------------------------
// UTF-16-safe truncation at the three bench dump call sites.
// Uses the same truncateUtf16Safe helper imported by the bench script,
// same boundary lengths (300, 400), and same input shape (trimmed text,
// message content, finalText).
// ---------------------------------------------------------------------------

const CAT = "\u{1F431}"; // 🐱 — 2 UTF-16 code units

const hasTrailingSurrogate = (s: string): boolean => {
  const code = s.charCodeAt(s.length - 1);
  return code >= 0xd800 && code <= 0xdfff;
};

describe("bench dump UTF-16 truncation", () => {
  // Site 1: L693 — `ASSISTANT text: ${truncateUtf16Safe(b.text.trim(), 300)}`
  it("strips a surrogate pair straddling the 300-unit ASSISTANT text boundary", () => {
    const prefix = "A".repeat(299);
    const text = truncateUtf16Safe(`${prefix}${CAT} trailing`.trim(), 300);
    const trail = `ASSISTANT text: ${text}`;
    expect(hasTrailingSurrogate(trail)).toBe(false);
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it("keeps normal ASSISTANT text identical to slice at 300", () => {
    const input = "A".repeat(500);
    expect(truncateUtf16Safe(input, 300)).toBe(input.slice(0, 300));
  });

  // Site 2: L698 — `TOOLRESULT ${name}: ${truncateUtf16Safe(textFromMessageContent(content), 400)}`
  it("strips a surrogate pair straddling the 400-unit TOOLRESULT boundary", () => {
    const prefix = "A".repeat(399);
    const text = truncateUtf16Safe(`${prefix}${CAT} more`, 400);
    const trail = `TOOLRESULT myTool: ${text}`;
    expect(hasTrailingSurrogate(trail)).toBe(false);
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it("keeps normal TOOLRESULT text identical to slice at 400", () => {
    const input = "A".repeat(500);
    expect(truncateUtf16Safe(input, 400)).toBe(input.slice(0, 400));
  });

  // Site 3: L730 — `finalText: truncateUtf16Safe(finalText, 400)`
  it("strips a surrogate pair straddling the 400-unit finalText boundary", () => {
    const prefix = "A".repeat(399);
    const finalText = truncateUtf16Safe(`${prefix}${CAT} trailing`, 400);
    expect(hasTrailingSurrogate(finalText)).toBe(false);
    expect(finalText.length).toBeLessThanOrEqual(400);
  });

  it("round-trips finalText through JSON.stringify cleanly", () => {
    const prefix = "A".repeat(399);
    const finalText = truncateUtf16Safe(`${prefix}${CAT}extra`, 400);
    const result = { finalText };
    const rt = JSON.parse(JSON.stringify(result));
    expect(rt.finalText).toBe(finalText);
    expect(hasTrailingSurrogate(rt.finalText)).toBe(false);
  });
});
