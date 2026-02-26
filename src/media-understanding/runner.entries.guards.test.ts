import { describe, expect, it } from "vitest";
import type { MediaUnderstandingDecision } from "./types.js";
import { formatDecisionSummary } from "./runner.entries.js";

describe("media-understanding formatDecisionSummary guards", () => {
  it("does not throw when decision.attachments is undefined", () => {
    const run = () =>
      formatDecisionSummary({
        capability: "image",
        outcome: "skipped",
        attachments: undefined as unknown as MediaUnderstandingDecision["attachments"],
      });

    expect(run).not.toThrow();
    expect(run()).toBe("image: skipped");
  });

  it("does not throw when attachment attempts is malformed", () => {
    const run = () =>
      formatDecisionSummary({
        capability: "video",
        outcome: "skipped",
        attachments: [{ attachmentIndex: 0, attempts: { bad: true } }],
      } as unknown as MediaUnderstandingDecision);

    expect(run).not.toThrow();
    expect(run()).toBe("video: skipped (0/1)");
  });
});
