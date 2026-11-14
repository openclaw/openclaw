import { assert, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  loadSessionEntry as readEntry,
  loadTranscriptEvents as readEvents,
  readSessionTranscriptMessageEvents as readMessages,
  rewindSessionToMessage as rewind,
} from "./session-accessor.js";
import { useSessionMessageCutFixtures } from "./session-accessor.sqlite-message-cut.test-support.js";

const { createSession } = useSessionMessageCutFixtures();

/**
 * An in-place rewind keeps the transcript identity, so the lifecycle revision is
 * the fence that retires a live writer holding pre-rewind state. Without it an
 * owner-fenced append still matches, lands on the pre-cut tail and resurrects
 * the branch the rewind just left.
 */
it("fences a live writer that holds the pre-rewind incarnation", async () => {
  const { scope, params } = await createSession();
  const before = readEntry(scope);
  assert(before);
  // Captured by a live SessionManager before the cut.
  const staleOwner = {
    lifecycleRevision: before.lifecycleRevision,
    activeWriterRunId: before.activeWriterRunId,
  };

  const result = await rewind(params);
  assert(result.status === "created");
  expect(result.entry.sessionId).toBe(scope.sessionId);

  await expect(
    appendTranscriptMessage(
      { ...scope, expectedOwner: staleOwner },
      {
        eventId: "stale-assistant",
        message: { role: "assistant", content: "resurrected tail" },
        parentId: "assistant-2",
      },
    ),
  ).rejects.toThrow("session writer claim changed before transcript persistence");

  // The repoint survives and the stale event never reached the transcript.
  expect(result.entry.lifecycleRevision).not.toBe(before.lifecycleRevision);
  expect(readMessages(scope)).toHaveLength(2);
  const events = await readEvents(scope);
  expect(
    events.some(
      (event) =>
        event && typeof event === "object" && "id" in event && event.id === "stale-assistant",
    ),
  ).toBe(false);
});
