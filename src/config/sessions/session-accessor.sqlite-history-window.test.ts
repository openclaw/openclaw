import { expect, it } from "vitest";
import { appendTranscriptEvent, replaceTranscriptEvents } from "./session-accessor.js";
import { readSessionTranscriptHistoryEventPage } from "./session-accessor.sqlite-history-events.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-history-window-");

it("continues an ID-less history window across harmless appends", async () => {
  const scope = {
    agentId: "main",
    sessionId: "history-events-test",
    sessionKey: "agent:main:history-events-test",
    storePath: fixture.storePath(),
  };
  const originalEvents = [
    { message: { role: "user", content: "older legacy row" } },
    { message: { role: "assistant", content: "newer legacy row" } },
  ];
  await replaceTranscriptEvents(scope, originalEvents);
  const original = readSessionTranscriptHistoryEventPage(scope, { maxMessages: 2, offset: 0 });
  expect(original).not.toHaveProperty("readWindow");
  const captured = readSessionTranscriptHistoryEventPage(scope, {
    maxMessages: 1,
    offset: 0,
    captureReadWindow: true,
  });
  const readWindow = captured.readWindow;
  expect(readWindow).toEqual({
    source: original.displaySource,
    latestResetRawSeq: null,
    anchor: { rawSeq: 1, seq: 2 },
  });
  if (!readWindow) {
    throw new Error("missing captured transcript window");
  }

  await appendTranscriptEvent(scope, {
    message: { role: "assistant", content: "appended legacy row" },
  });
  const continued = readSessionTranscriptHistoryEventPage(scope, {
    beforeSeq: 3,
    offset: 0,
    maxMessages: 2,
    recentAtHead: { maxBytes: 64 * 1024, maxLines: 3, maxMessages: 3 },
    expectedReadWindow: readWindow,
  });
  expect(continued.events).toEqual(original.events);
  expect(continued.totalMessages).toBe(3);
  expect(continued).not.toHaveProperty("readWindow");
  expect(
    readSessionTranscriptHistoryEventPage(scope, {
      beforeSeq: 3,
      offset: 1,
      maxMessages: 1,
      expectedReadWindow: readWindow,
    }).events,
  ).toEqual(original.events.slice(0, 1));
});
