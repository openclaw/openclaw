// Tests usage-line formatting for agent runner completion summaries.
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUsageLine, formatResponseUsageLine } from "./agent-runner-usage-line.js";

describe("formatResponseUsageLine", () => {
  it("handles total-only usage without input/output split", () => {
    const result = formatResponseUsageLine({
      usage: { total: 1250 },
      showCost: false,
    });
    expect(result).toBe("Usage: 1.3k total");
  });

  it("handles total-only usage with cost estimation", () => {
    const result = formatResponseUsageLine({
      usage: { total: 1250 },
      showCost: true,
      costConfig: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    expect(result).toContain("Usage: 1.3k total");
  });

  it("returns null for empty usage", () => {
    const result = formatResponseUsageLine({
      usage: {},
      showCost: false,
    });
    expect(result).toBeNull();
  });

  it("returns null for undefined usage", () => {
    const result = formatResponseUsageLine({
      usage: undefined,
      showCost: false,
    });
    expect(result).toBeNull();
  });
});

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
