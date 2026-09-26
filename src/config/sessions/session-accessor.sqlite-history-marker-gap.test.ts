import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptMessage, replaceTranscriptEvents } from "./session-accessor.js";
import { readSessionTranscriptHistoryEventPage } from "./session-accessor.sqlite-history-events.js";
import { readSessionTranscriptHistoryEventCount } from "./session-accessor.sqlite-history.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  {
    name: "mixed interior and trailing",
    layout: [
      "message",
      "notice",
      "notice",
      "hidden",
      "message",
      "notice",
      "message",
      "notice",
      "notice",
    ],
    expected: ["row-0", "row-1", "row-2", "row-4", "row-5", "row-6", "row-7", "row-8"],
  },
  {
    name: "leading",
    layout: ["notice", "message", "notice", "message"],
    expected: ["row-0", "row-1", "row-2", "row-3"],
  },
  {
    name: "message-free",
    layout: ["notice", "hidden", "notice"],
    expected: ["row-0", "row-2"],
  },
])("keeps $name marker-gap ordinals across an append", async ({ layout, expected }) => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("history-marker-gap-") },
    sessionId: "marker-gap",
    sessionKey: "agent:main:marker-gap",
  };
  await replaceTranscriptEvents(scope, [
    { type: "session", version: 3, id: scope.sessionId },
    ...layout.map((kind, index) => ({
      id: `row-${index}`,
      parentId: index === 0 ? null : `row-${index - 1}`,
      ...(kind === "message"
        ? { type: "message", message: { role: "user", content: `row ${index}` } }
        : {
            type: "custom_message",
            customType: "notice",
            display: kind !== "hidden",
            content: `row ${index}`,
          }),
    })),
  ]);
  expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expected.length);
  const sibling = { ...scope, sessionId: "sibling", sessionKey: "agent:main:sibling" };
  await replaceTranscriptEvents(sibling, [
    { type: "message", id: "seed", parentId: null, message: { role: "user", content: "seed" } },
    { type: "compaction", id: "summary", parentId: "seed", summary: "sibling summary" },
  ]);
  expect(readSessionTranscriptHistoryEventCount(sibling)).toBe(2);
  expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expected.length);
  for (const offset of [0, 2, 4, 6].filter((pageOffset) => pageOffset < expected.length)) {
    const page = readSessionTranscriptHistoryEventPage(scope, { maxMessages: 3, offset });
    const end = expected.length - offset;
    const start = Math.max(0, end - 3);
    expect(page.totalMessages).toBe(expected.length);
    expect(page.events.map(({ event }) => event)).toEqual(
      expected.slice(start, end).map((id) => expect.objectContaining({ id })),
    );
    expect(page.events.map(({ seq }) => seq)).toEqual(
      Array.from({ length: end - start }, (_, index) => start + index + 1),
    );
  }
  await appendTranscriptMessage(scope, {
    eventId: "new-tail",
    parentId: `row-${layout.length - 1}`,
    message: { role: "assistant", content: "fresh" },
  });
  const fresh = readSessionTranscriptHistoryEventPage(scope, { maxMessages: 3, offset: 0 });
  expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expected.length + 1);
  expect(readSessionTranscriptHistoryEventCount(sibling)).toBe(2);
  expect(fresh.totalMessages).toBe(expected.length + 1);
  expect(fresh.events.map(({ event }) => event)).toEqual(
    [...expected.slice(-2), "new-tail"].map((id) => expect.objectContaining({ id })),
  );
  expect(fresh.events.map(({ seq }) => seq)).toEqual([
    expected.length - 1,
    expected.length,
    expected.length + 1,
  ]);
});
