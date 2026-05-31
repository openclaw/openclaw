import { describe, expect, it } from "vitest";
import { resolveMaxActiveTranscriptBytes } from "./memory-flush.js";

describe("resolveMaxActiveTranscriptBytes", () => {
  it("prefers a per-agent compaction override when agentId is provided", () => {
    expect(
      resolveMaxActiveTranscriptBytes(
        {
          agents: {
            defaults: {
              compaction: {
                truncateAfterCompaction: false,
                maxActiveTranscriptBytes: "1mb",
              },
            },
            list: [
              {
                id: "main",
                compaction: {
                  truncateAfterCompaction: true,
                  maxActiveTranscriptBytes: "2mb",
                },
              },
            ],
          },
        },
        "main",
      ),
    ).toBe(2 * 1024 * 1024);
  });

  it("falls back to defaults when no per-agent override is present", () => {
    expect(
      resolveMaxActiveTranscriptBytes({
        agents: {
          defaults: {
            compaction: {
              truncateAfterCompaction: true,
              maxActiveTranscriptBytes: "1mb",
            },
          },
        },
      }),
    ).toBe(1024 * 1024);
  });
});
