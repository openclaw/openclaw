import { expect, it, vi } from "vitest";
import { readSessionTranscriptAccountingFromReplica } from "./session-transcript-accounting-replica.js";

const contextStats = vi.hoisted(() => ({ sizeBytes: 999, eventCount: 3 }));

vi.mock("./session-actor-replica.js", () => ({
  readSessionActorTranscriptStateFromReplica: () => ({ transcript: { contextStats } }),
  readSessionActorCompleteTranscriptFromReplica: () => undefined,
}));

const target = { path: "/tmp/agent.sqlite", sessionKey: "agent:main:test", sessionId: "test" };

it("declines the resident shortcut when saved prompt checkpoints must be excluded", () => {
  expect(
    readSessionTranscriptAccountingFromReplica(target, {
      includeByteSize: true,
      includeUsage: false,
      excludeSystemPromptCheckpoints: true,
    }),
  ).toBeUndefined();
});

it("keeps the resident shortcut for ordinary byte accounting", () => {
  expect(
    readSessionTranscriptAccountingFromReplica(target, {
      includeByteSize: true,
      includeUsage: false,
    }),
  ).toEqual({ byteSize: 999, eventCount: 3 });
});
