import { describe, expect, it } from "vitest";
import { formatDecisionSummary } from "./runner.entries.js";
import type { MediaUnderstandingDecision } from "./types.js";

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

  it("ignores non-string provider/model/reason fields", () => {
    const run = () =>
      formatDecisionSummary({
        capability: "audio",
        outcome: "failed",
        attachments: [
          {
            attachmentIndex: 0,
            chosen: {
              outcome: "failed",
              provider: { bad: true },
              model: 42,
            },
            attempts: [{ reason: { malformed: true } }],
          },
        ],
      } as unknown as MediaUnderstandingDecision);

    expect(run).not.toThrow();
    expect(run()).toBe("audio: failed (0/1)");
  });
});
