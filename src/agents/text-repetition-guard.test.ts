import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_REPETITION_GUARD_CONFIG,
  detectTextRepetition,
} from "./text-repetition-guard.js";

describe("text-repetition-guard", () => {
  const cfg = DEFAULT_TEXT_REPETITION_GUARD_CONFIG;

  // -----------------------------------------------------------------------
  // Should detect
  // -----------------------------------------------------------------------

  it("detects 'Wait/Check/Done/Sent' loop (real Gemini failure mode)", () => {
    // Real failure mode: model emits same boilerplate without variation.
    let text = "I will now verify each item:\n";
    for (let i = 0; i < 30; i++) {
      text += "Wait, I should check this item... Done. Sent.\n";
    }
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(true);
  });

  it("detects consecutive identical lines", () => {
    const text = "Starting analysis...\n" + "Wait, I should check this again.\n".repeat(20);
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(true);
    if (result.looping) {
      expect(result.detector).toBe("identical_lines");
    }
  });

  it("detects suffix cycle pattern", () => {
    const text = "Let me verify the details. ".repeat(5) + "Check. Verify. Done. ".repeat(30);
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(true);
    if (result.looping) {
      expect(result.detector).toBe("suffix_cycle");
    }
  });

  it("detects line-group cycle", () => {
    let text = "Starting the verification process now:\n";
    for (let i = 0; i < 30; i++) {
      text += "Step A: checking the verification status\nStep B: verifying the check result\n";
    }
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(true);
  });

  it("detects HEARTBEAT_OK spam", () => {
    const text = "HEARTBEAT_OK\n".repeat(80);
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(true);
  });

  it("detects CJK (Chinese) repetition", () => {
    const text = "等一下，让我再确认一下这个问题。已完成确认。\n".repeat(30);
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Should NOT detect (false positive checks)
  // -----------------------------------------------------------------------

  it("passes normal prose text", () => {
    const sentences = [
      "The weather is nice today.",
      "I found several interesting results.",
      "Let me explain the architecture.",
      "The database uses PostgreSQL.",
      "Authentication is handled via JWT.",
      "The frontend is built with React.",
      "CI/CD runs on GitHub Actions.",
      "Deployment targets are AWS and GCP.",
      "Monitoring uses Prometheus and Grafana.",
      "The API follows REST conventions.",
    ];
    const text = sentences
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n")
      .repeat(3);
    // Ensure sufficient length
    const padded =
      text.length >= 700
        ? text
        : text + "\nAdditional unique content for padding purposes.".repeat(10);
    const result = detectTextRepetition(padded, cfg);
    expect(result.looping).toBe(false);
  });

  it("passes code blocks with similar structure", () => {
    let code = "Here is the implementation:\n```typescript\n";
    for (let i = 0; i < 15; i++) {
      code += `  const item${i} = await fetch(url${i});\n`;
      code += `  results.push(item${i}.json());\n`;
    }
    code += "```\n";
    const padded =
      code.length >= 700 ? code : code + "\nThe code above handles data fetching.".repeat(5);
    const result = detectTextRepetition(padded, cfg);
    expect(result.looping).toBe(false);
  });

  it("passes numbered lists with unique items", () => {
    let text = "";
    for (let i = 1; i <= 30; i++) {
      text += `${i}. Item number ${i} with unique description about topic ${i}\n`;
    }
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(false);
  });

  it("passes templated steps with shared stem but progressive numbering", () => {
    // "Step 1: process item...", "Step 2: process item..." share a 30-char
    // stem but are progressive, not looping.
    let text = "Here is the plan:\n";
    for (let i = 1; i <= 30; i++) {
      text += `Step ${i}: process item and verify the output result\n`;
    }
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(false);
  });

  it("passes progressive content where repeated ngrams come from distinct lines", () => {
    // Each line shares a long common suffix but the lines themselves differ
    // (e.g. numbered items with the same tail). The ngram detector should
    // recognise the line diversity and skip.
    let text = "";
    for (let i = 1; i <= 30; i++) {
      text += `Item ${i}: verify the output result and confirm correctness of this entry\n`;
    }
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(false);
  });

  it("passes short text below minimum threshold", () => {
    const text = "Done. Sent. ".repeat(10);
    const result = detectTextRepetition(text, cfg);
    expect(result.looping).toBe(false);
  });

  it("returns looping=false when disabled", () => {
    const text = "repeat this line\n".repeat(100);
    const result = detectTextRepetition(text, { ...cfg, enabled: false });
    expect(result.looping).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Config resolution
  // -----------------------------------------------------------------------

  it("uses defaults when partial config provided", () => {
    const text = "repeat this exact line over and over!\n".repeat(50);
    // Only override enabled
    const result = detectTextRepetition(text, { enabled: true });
    expect(result.looping).toBe(true);
  });
});
