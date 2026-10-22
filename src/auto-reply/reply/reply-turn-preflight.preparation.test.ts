import { beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import { prepareReplyTurnContext } from "./reply-turn-preflight.js";
import { createMockReplyOperation } from "./test-helpers.js";

const memory = vi.hoisted(() => ({ compact: vi.fn(), flush: vi.fn() }));
// mock-isolation: Hold the maintenance boundary to observe the source before model work starts.
vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: memory.compact,
  runMemoryFlushIfNeeded: memory.flush,
}));

beforeEach(() => vi.clearAllMocks());

it("awaits preparation feedback before the required memory checkpoint", async () => {
  const events: string[] = [];
  const entry: SessionEntry = { sessionId: "synthetic", updatedAt: 0 };
  memory.compact.mockImplementation(async (params) => await params.beforeCompaction(entry));
  memory.flush.mockImplementation(async () => {
    events.push("memory checkpoint");
    return { sessionEntry: entry, outcome: "completed" };
  });
  const onReplyPreparation = vi.fn(async () => {
    await Promise.resolve();
    events.push("preparation notice");
  });
  const { replyOperation } = createMockReplyOperation();
  try {
    await prepareReplyTurnContext({
      cfg: {},
      followupRun: createTestFollowupRun(),
      defaultModel: "synthetic/model",
      isHeartbeat: false,
      replyOperation,
      resolvedVerboseLevel: "off",
      publishCheckpoint: () => {},
      opts: { onReplyPreparation },
    });
    expect(events).toEqual(["preparation notice", "memory checkpoint"]);
    expect(onReplyPreparation).toHaveBeenCalledExactlyOnceWith("context");
  } finally {
    replyOperation.complete();
  }
});
