import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { readSessionTranscriptCohort } from "./session-transcript-read-cohort.js";

it.each(["sibling", "same"] as const)(
  "validates transcript snapshots across %s session writes",
  async (kind) => {
    await withOpenClawTestState({ label: "transcript-cohort-sibling-writes" }, async (state) => {
      const storePath = state.statePath("transcript.sqlite");
      const target = {
        agentId: "main",
        storePath,
        sessionKey: "agent:main:reader",
        sessionId: "reader",
      };
      const sibling =
        kind === "same"
          ? target
          : { ...target, sessionKey: "agent:main:writer", sessionId: "writer" };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      await upsertSessionEntryCore(sibling, { sessionId: sibling.sessionId, updatedAt: 1 });
      let updates = 1;
      const read = vi.fn(async () => {
        await upsertSessionEntryCore(sibling, {
          sessionId: sibling.sessionId,
          updatedAt: ++updates,
        });
        return "unchanged transcript";
      });
      const consume = vi.fn((snapshot: string) => snapshot);
      const reading = readSessionTranscriptCohort(
        { agentId: target.agentId, path: storePath, env: process.env },
        read,
        consume,
        () => {},
        undefined,
        "history.hydration",
        target,
      );
      if (kind === "same") {
        await expect(reading).rejects.toThrow("Session entry changed during read");
        expect(read).toHaveBeenCalledTimes(2);
        expect(consume).not.toHaveBeenCalled();
      } else {
        await expect(reading).resolves.toBe("unchanged transcript");
        expect(read).toHaveBeenCalledTimes(1);
        expect(consume).toHaveBeenCalledTimes(1);
      }
    });
  },
);
