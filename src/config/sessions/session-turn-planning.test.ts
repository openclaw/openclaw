import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

// mock-isolation: Automatic maintenance must not race this transcript ordering fixture.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget background work is independent of callback selection.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

it.each(["before", "during"] as const)(
  "rejects a rebound %s the shouldAppend callback without persisting a message",
  async (reboundAt) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createSessionCompoundWorkerFixture();
      const rebound = () =>
        replaceSessionEntrySync(f.scope, { sessionId: "successor", updatedAt: 2 });
      const shouldAppend = vi.fn(async () => {
        rebound();
        return true;
      });
      if (reboundAt === "before") {
        rebound();
      }
      const result = await appendExpectedSessionTranscriptTurn(f.scope, {
        expectedSessionId: f.scope.sessionId,
        sessionFile: "synthetic-session.jsonl",
        messages: [{ message: { role: "user", content: "stale input" }, shouldAppend }],
      });
      expect(result).toMatchObject({
        rejectedReason: "session-rebound",
        appendedMessages: [],
        sessionEntry: { sessionId: "successor" },
      });
      expect(shouldAppend).toHaveBeenCalledTimes(reboundAt === "before" ? 0 : 1);
      expect(f.events()).toEqual([]);
      expect(f.read()?.sessionId).toBe("successor");
    });
  },
);
