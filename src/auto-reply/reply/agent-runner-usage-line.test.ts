// Tests usage-line formatting for agent runner completion summaries.
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUsageLine, resolveResponseUsageLine } from "./agent-runner-usage-line.js";

describe("appendUsageLine", () => {
  it("preserves reply payload metadata when appending usage text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "message tool reply" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "message tool reply",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = appendUsageLine([payload], "Usage: 12 in / 3 out");

    expect(updated).toEqual({ text: "message tool reply\nUsage: 12 in / 3 out" });
    expect(getReplyPayloadMetadata(updated)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:telegram:direct:123",
        idempotencyKey: "run-1:internal-source-reply:0",
        text: "message tool reply\nUsage: 12 in / 3 out",
      },
    });
  });
});

describe("resolveResponseUsageLine", () => {
  it("preserves Braille meter characters in usage bar output", () => {
    // Braille scale characters: ⠐⡀⡄⡆⡇⣇⣧⣷⣿ (U+2800-U+28FF range)
    // These are used for context token usage visualization and must be preserved.
    const result = resolveResponseUsageLine({
      config: {
        messages: {
          responseUsage: "full",
          usageTemplate: {
            output: {
              sep: "",
              default: [
                {
                  text: " | 📚[{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
                },
              ],
            },
            scales: {
              braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
            },
          },
        },
      } as any,
      sessionRaw: null,
      channel: undefined,
      usage: { input: 7500, output: 1000, cacheRead: 0, cacheWrite: 0 },
      provider: undefined,
      model: undefined,
      preserveUserFacingSessionState: false,
      replyUsageState: {
        agentId: "main",
        usage: { input: 7500, output: 1000, cacheRead: 0, cacheWrite: 0, total: 8500 },
        contextUsedTokens: 7500,
        contextTokenBudget: 10000,
      },
    });

    // The result should contain Braille meter characters for 75% usage (3 full + 1 partial)
    // Expected: " | 📚[⣿⣿⣿⣧⠐]10k" or similar with Braille glyphs
    expect(result).toBeDefined();
    expect(result).toContain("📚");
    // Verify Braille characters are present (U+2800-U+28FF range)
    expect(result).toMatch(/[\u2800-\u28FF]+/);
    // Verify the meter shows appropriate fill for 75% (should have multiple full cells)
    expect(result?.match(/⣿/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("does not filter Braille characters when rendering usage bar", () => {
    // This test ensures that the fix for issue #105481 does not accidentally
    // remove Braille meter characters, which are essential for usage visualization.
    const usageLine = resolveResponseUsageLine({
      config: {
        messages: {
          responseUsage: "full",
          usageTemplate: {
            output: {
              sep: "",
              default: [{ text: "[{context.pct_used|meter:5:braille}]" }],
            },
            scales: {
              braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
            },
          },
        },
      } as any,
      sessionRaw: null,
      channel: undefined,
      usage: { input: 5000, output: 500, cacheRead: 0, cacheWrite: 0 },
      provider: undefined,
      model: undefined,
      preserveUserFacingSessionState: false,
      replyUsageState: {
        agentId: "main",
        usage: { input: 5000, output: 500, cacheRead: 0, cacheWrite: 0, total: 5500 },
        contextUsedTokens: 5000,
        contextTokenBudget: 10000,
      },
    });

    // 50% on a 5-cell braille meter should show: [⡇⠐⠐⠐⠐] or similar
    expect(usageLine).toBeDefined();
    expect(usageLine).toMatch(/\[.*[\u2800-\u28FF].*\]/);
  });
});
