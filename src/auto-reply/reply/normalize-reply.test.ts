import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { normalizeReplyPayload } from "./normalize-reply.js";

// Keep channelData-only payloads so channel-specific replies survive normalization.
describe("normalizeReplyPayload", () => {
  it("keeps channelData-only replies", () => {
    const payload = {
      channelData: {
        line: {
          flexMessage: { type: "bubble" },
        },
      },
    };

    const normalized = normalizeReplyPayload(payload);

    expect(normalized).not.toBeNull();
    expect(normalized?.text).toBeUndefined();
    expect(normalized?.channelData).toEqual(payload.channelData);
  });

  it("records silent skips", () => {
    const reasons: string[] = [];
    const normalized = normalizeReplyPayload(
      { text: SILENT_REPLY_TOKEN },
      {
        onSkip: (reason) => reasons.push(reason),
      },
    );

    expect(normalized).toBeNull();
    expect(reasons).toEqual(["silent"]);
  });

  it("preserves assistant content discussing billing topics (#13434)", () => {
    const prose =
      "**Billing:** Processed through ABC Financial Services. Members pay 26 bi-weekly **payments** of $19.99.";
    const normalized = normalizeReplyPayload({ text: prose });
    expect(normalized).not.toBeNull();
    expect(normalized?.text).toBe(prose);
  });

  it("rewrites real billing error through normalizeReplyPayload (#13434)", () => {
    const normalized = normalizeReplyPayload({ text: "insufficient credits" });
    expect(normalized).not.toBeNull();
    expect(normalized?.text).toContain("billing error");
  });

  it("records empty skips", () => {
    const reasons: string[] = [];
    const normalized = normalizeReplyPayload(
      { text: "   " },
      {
        onSkip: (reason) => reasons.push(reason),
      },
    );

    expect(normalized).toBeNull();
    expect(reasons).toEqual(["empty"]);
  });
});
