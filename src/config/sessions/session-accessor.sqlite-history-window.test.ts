import { expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  replaceTranscriptEvents,
} from "./session-accessor.js";
import { readSessionTranscriptHistoryEventPage } from "./session-accessor.sqlite-history-events.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-history-window-");

it("rebases a retained anchor into the current reset window", async () => {
  const scope = {
    agentId: "main",
    sessionId: "kept-window",
    sessionKey: "agent:main:kept-window",
    storePath: fixture.storePath(),
  };
  await replaceTranscriptEvents(
    scope,
    [1, 2, 3].map((seq) => ({
      type: "message",
      id: `row-${seq}`,
      parentId: seq === 1 ? null : `row-${seq - 1}`,
      message: { role: "user", content: `row ${seq}` },
    })),
  );
  const first = readSessionTranscriptHistoryEventPage(scope, {
    maxMessages: 1,
    offset: 0,
    captureReadWindow: true,
  });
  await appendTranscriptEvent(scope, {
    type: "reset",
    id: "reset",
    parentId: "row-3",
    firstKeptEntryId: "row-2",
    reason: "new",
  });
  const page = readSessionTranscriptHistoryEventPage(scope, {
    maxMessages: 1,
    offset: 0,
    beforeSeq: 3,
    expectedReadWindow: first.readWindow,
  });
  expect(page).toMatchObject({
    windowReset: true,
    events: [{ seq: 1, event: { id: "row-2" } }],
    readWindow: { anchor: { seq: 1 } },
  });
});

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

it.each(["reset", "replacement"])("recovers a stale history window after %s", async (change) => {
  const scope = {
    agentId: "main",
    sessionId: "stale-window",
    sessionKey: "agent:main:stale-window",
    storePath: fixture.storePath(),
  };
  await replaceTranscriptEvents(scope, [
    { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
  ]);
  const previous = readSessionTranscriptHistoryEventPage(scope, {
    maxMessages: 1,
    offset: 0,
    captureReadWindow: true,
  });
  if (change === "reset") {
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset",
      parentId: "old",
      reason: "new",
    });
    await appendTranscriptMessage(scope, {
      eventId: "current",
      message: { role: "user", content: "current" },
    });
  } else {
    await replaceTranscriptEvents(scope, [
      {
        type: "message",
        id: "current",
        parentId: null,
        message: { role: "user", content: "current" },
      },
    ]);
  }
  const page = readSessionTranscriptHistoryEventPage(scope, {
    maxMessages: 1,
    offset: 10,
    beforeSeq: 1,
    expectedReadWindow: previous.readWindow,
  });
  expect(page).toMatchObject({ windowReset: true, events: [{ event: { id: "current" } }] });
  expect(page.readWindow).toBeDefined();
  expect(page.readWindow).not.toEqual(previous.readWindow);
  expect(
    readSessionTranscriptHistoryEventPage(scope, {
      maxMessages: 1,
      offset: 0,
      expectedReadWindow: page.readWindow,
    }).events,
  ).toEqual(page.events);
});
