import { expect, it } from "vitest";
import { aggregateSessionTranscriptUsage } from "./session-transcript-derived-readers.js";

const zeroUsage = {
  input: 0,
  output: 0,
  totalTokens: 0,
  contextUsage: { state: "available" as const, promptTokens: 0, totalTokens: 0 },
};

it.each(["sqlite", "artifact"] as const)(
  "retains authoritative zero usage from %s transcripts",
  (source) => {
    const snapshot = aggregateSessionTranscriptUsage(
      [
        {
          role: "assistant",
          provider: "ollama",
          model: "llama3.2",
          usage: { ...zeroUsage, usageReport: { state: "available" } },
        },
      ],
      source,
    );
    expect(snapshot).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
      usageReport: { state: "available" },
    });
  },
);

it("does not promote legacy artifact zero counters to a fresh context measurement", () => {
  const snapshot = aggregateSessionTranscriptUsage(
    [{ role: "assistant", provider: "ollama", model: "llama3.2", usage: zeroUsage }],
    "artifact",
  );
  expect(snapshot?.totalTokens).toBeUndefined();
  expect(snapshot?.totalTokensFresh).toBeUndefined();
});
