import { assert, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  readSessionTranscriptMessageEvents,
  rewindSessionToMessage,
  switchSessionBranch,
} from "./session-accessor.js";
import { useSessionMessageCutFixtures } from "./session-accessor.sqlite-message-cut.test-support.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";

const { createSession } = useSessionMessageCutFixtures();

it.each([
  { reason: "idle" },
  { reason: "daily" },
  { reason: "cron-stale" },
  { reason: "reset", firstKeptEntryId: "user-1" },
  { reason: "reset", context: "preserve-tail" },
])(
  "rejects non-manual reset $reason/$firstKeptEntryId/$context without changing persisted state",
  async (boundary) => {
    const { scope, params } = await createSession();
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "automatic-reset",
      parentId: "assistant-2",
      timestamp: "2026-07-18T01:00:00.000Z",
      ...boundary,
    });
    const entry = loadSessionEntry(params);
    const events = await loadTranscriptEvents(scope);
    const request = { ...params, entryId: "automatic-reset", undoReset: true };
    expect((await rewindSessionToMessage(request)).status).not.toBe("created");
    expect(loadSessionEntry(params)).toEqual(entry);
    expect(await loadTranscriptEvents(scope)).toEqual(events);
  },
);

it("undoes the latest reset through the worker while preserving later messages as a branch", async () => {
  const { scope, params } = await createSession();
  const previous = readSessionTranscriptMessageEvents(scope);
  await appendTranscriptEvent(scope, {
    type: "reset",
    id: "reset-1",
    parentId: "assistant-2",
    reason: "reset",
    timestamp: "2026-07-18T01:00:00.000Z",
  });
  await appendTranscriptMessage(scope, {
    eventId: "later-user",
    parentId: "reset-1",
    now: Date.parse("2026-07-18T01:00:01.000Z"),
    message: { role: "user", content: "after reset" },
  });
  expect(readSessionTranscriptMessageEvents(scope)).toHaveLength(1);

  const undo = { ...params, entryId: "reset-1", undoReset: true };
  const result = await rewindSessionToMessage(undo);
  assert(result.status === "created");
  const restored = { ...scope, sessionId: result.entry.sessionId };
  expect(readSessionTranscriptMessageEvents(restored)).toEqual(previous);
  const context = readSessionTranscriptModelContext(restored);
  // Detached snapshots must hydrate only the selected branch, not its retained successor.
  expect(JSON.stringify(context.events)).toContain("first prompt");
  expect(JSON.stringify(context.events)).not.toContain("after reset");
  expect(await loadTranscriptEvents(restored)).toContainEqual(
    expect.objectContaining({ id: "later-user" }),
  );
  expect(result.entry.sessionId).not.toBe(scope.sessionId);
  expect(result.entry.agentHarnessId).toBeUndefined();
  expect(result.entry.cliSessionIds).toBeUndefined();
  expect(result.editorText).toBeUndefined();
  expect(loadSessionEntry(params)?.sessionId).toBe(result.entry.sessionId);

  await appendTranscriptMessage(restored, {
    eventId: "restored-user",
    parentId: "assistant-2",
    message: { role: "user", content: "restored branch" },
  });
  const switched = await switchSessionBranch({ ...params, leafEntryId: "later-user" });
  assert(switched.status === "created");
  expect(
    readSessionTranscriptMessageEvents({ ...scope, sessionId: switched.entry.sessionId }),
  ).toHaveLength(1);
  const back = await switchSessionBranch({ ...params, leafEntryId: "restored-user" });
  assert(back.status === "created");
  const backScope = { ...scope, sessionId: back.entry.sessionId };
  expect(readSessionTranscriptMessageEvents(backScope)).toEqual([
    ...previous,
    expect.objectContaining({ event: expect.objectContaining({ id: "restored-user" }) }),
  ]);
  expect(JSON.stringify(readSessionTranscriptModelContext(backScope).events)).not.toContain(
    "after reset",
  );
});

it("undoes repeated resets one at a time and rejects stale or empty-history targets without mutation", async () => {
  const { scope, params } = await createSession();
  const previous = readSessionTranscriptMessageEvents(scope);
  await appendTranscriptEvent(scope, {
    type: "reset",
    id: "reset-1",
    parentId: "assistant-2",
    reason: "new",
    timestamp: "2026-07-18T01:00:00.000Z",
  });
  await appendTranscriptEvent(scope, {
    type: "reset",
    id: "reset-2",
    parentId: "reset-1",
    reason: "new",
    timestamp: "2026-07-18T01:00:01.000Z",
  });
  const stale = { ...params, entryId: "reset-1", undoReset: true };
  expect((await rewindSessionToMessage(stale)).status).not.toBe("created");
  expect(loadSessionEntry(params)?.sessionId).toBe(scope.sessionId);

  const latest = { ...params, entryId: "reset-2", undoReset: true };
  const first = await rewindSessionToMessage(latest);
  assert(first.status === "created");
  expect(
    readSessionTranscriptMessageEvents({ ...scope, sessionId: first.entry.sessionId }),
  ).toEqual([]);
  expect((await rewindSessionToMessage(latest)).status).not.toBe("created");
  const second = await rewindSessionToMessage(stale);
  assert(second.status === "created");
  expect(
    readSessionTranscriptMessageEvents({ ...scope, sessionId: second.entry.sessionId }),
  ).toEqual(previous);
  expect((await rewindSessionToMessage(stale)).status).not.toBe("created");

  const current = { ...scope, sessionId: second.entry.sessionId };
  await appendTranscriptEvent(current, {
    type: "reset",
    id: "empty-reset",
    parentId: null,
    reason: "new",
    timestamp: "2026-07-18T01:00:02.000Z",
  });
  const empty = { ...params, entryId: "empty-reset", undoReset: true };
  expect((await rewindSessionToMessage(empty)).status).not.toBe("created");
  expect(loadSessionEntry(params)?.sessionId).toBe(second.entry.sessionId);
});

it("does not grant branch selection from an ignored older-reset marker", async () => {
  const { scope, params } = await createSession();
  await appendTranscriptEvent(scope, {
    type: "reset",
    id: "reset-1",
    parentId: "assistant-2",
    reason: "reset",
    context: "clear",
  });
  await appendTranscriptMessage(scope, {
    eventId: "after-first",
    parentId: "reset-1",
    message: { role: "user", content: "after first reset" },
  });
  await appendTranscriptEvent(scope, {
    type: "reset",
    id: "reset-2",
    parentId: "after-first",
    reason: "reset",
    context: "clear",
  });
  const undone = await rewindSessionToMessage({ ...params, entryId: "reset-2", undoReset: true });
  assert(undone.status === "created");
  const restored = { ...scope, sessionId: undone.entry.sessionId };
  await waitForSessionTranscriptIndexReconcilesInStateDir(params.env.OPENCLAW_STATE_DIR);
  const before = readSessionTranscriptMessageEvents(restored);
  await appendTranscriptEvent(restored, {
    type: "leaf",
    id: "ignored-reset-1",
    parentId: "after-first",
    targetId: "off-path-user",
    undoResetId: "reset-1",
  });
  await waitForSessionTranscriptIndexReconcilesInStateDir(params.env.OPENCLAW_STATE_DIR);
  expect(readSessionTranscriptMessageEvents(restored)).toEqual(before);
  const switched = await switchSessionBranch({ ...params, leafEntryId: "off-path-user" });
  assert(switched.status === "created");
  const next = { ...scope, sessionId: switched.entry.sessionId };
  await waitForSessionTranscriptIndexReconcilesInStateDir(params.env.OPENCLAW_STATE_DIR);
  const events = await loadTranscriptEvents(next);
  expect(events.at(-1)).toMatchObject({ type: "leaf" });
  expect(events.at(-1)).not.toHaveProperty("undoResetId");
  expect(readSessionTranscriptMessageEvents(next)).toEqual(before);
  expect(JSON.stringify(readSessionTranscriptModelContext(next).events)).not.toContain(
    "first prompt",
  );
});
