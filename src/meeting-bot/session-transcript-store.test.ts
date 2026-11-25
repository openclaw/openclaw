import { beforeEach, expect, it } from "vitest";
import { MeetingSessionTranscriptStore } from "./session-transcript-store.js";
import type { MeetingSessionRecord, MeetingTranscriptSnapshot } from "./session-types.js";

let session: MeetingSessionRecord<"chrome", "transcribe">;
let delivered: string[];
let unavailable: boolean;

beforeEach(() => {
  delivered = [];
  unavailable = false;
  session = {
    id: "session-1",
    url: "https://meeting.example/room",
    transport: "chrome",
    mode: "transcribe",
    agentId: "main",
    state: "active",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    participantIdentity: "OpenClaw",
    realtime: { enabled: false, toolPolicy: "none" },
    notes: [],
  };
});

async function deliver(lines: MeetingTranscriptSnapshot["lines"]) {
  if (unavailable) {
    throw new Error("store unavailable");
  }
  delivered.push(...lines.map((line) => line.text));
}

function createStore(snapshots: (MeetingTranscriptSnapshot | Error)[], onLines = deliver) {
  return new MeetingSessionTranscriptStore({
    getSession: (sessionId) => (sessionId === session.id ? session : undefined),
    isBrowserSession: () => true,
    isTranscribeSession: () => true,
    hasBrowserTab: () => true,
    capture: async () => {
      const next = snapshots[0];
      if (next instanceof Error) {
        throw next;
      }
      snapshots.shift();
      return next;
    },
    onLines: async (_session, lines) => await onLines(lines),
  });
}

function snapshot(texts: string[], epoch?: string, droppedLines = 0): MeetingTranscriptSnapshot {
  return { droppedLines, epoch, lines: texts.map((text) => ({ text })) };
}

it("trims an oversized initial snapshot to the retained tail", async () => {
  const texts = Array.from({ length: 2_005 }, (_, index) => `line-${index}`);
  const store = createStore([snapshot(texts, "page-1", 7)]);

  const result = await store.read(session.id);

  expect(result).toMatchObject({ found: true, startIndex: 12, nextIndex: 2_012, droppedLines: 12 });
  expect(result.lines?.map((line) => line.text)).toEqual(texts.slice(5));
});

it("keeps only the new epoch tail when its first snapshot already has a gap", async () => {
  const store = createStore([
    snapshot(["old-0", "old-1"], "page-1"),
    snapshot(["new-3", "new-4"], "page-2", 3),
    snapshot(["new-3", "new-4", "new-5"], "page-2", 3),
  ]);

  await store.read(session.id);
  const afterReload = await store.read(session.id, { sinceIndex: 2 });
  const afterAppend = await store.read(session.id, { sinceIndex: 7 });

  expect(afterReload).toMatchObject({ startIndex: 5, nextIndex: 7, droppedLines: 5 });
  expect(afterReload.lines?.map((line) => line.text)).toEqual(["new-3", "new-4"]);
  expect(afterAppend).toMatchObject({ startIndex: 7, nextIndex: 8, droppedLines: 5 });
  expect(afterAppend.lines?.map((line) => line.text)).toEqual(["new-5"]);
});

it("acknowledges a durable snapshot one line at a time", async () => {
  const batch = snapshot(["first", "second"], "page-1");
  let failedSecond = false;
  const store = createStore([batch, batch], async (lines) => {
    const text = lines[0]?.text;
    if (text === "second" && !failedSecond) {
      failedSecond = true;
      throw new Error("temporary second-line failure");
    }
    if (text) {
      delivered.push(text);
    }
  });

  await expect(store.read(session.id)).resolves.toMatchObject({ found: true });
  await expect(store.read(session.id)).resolves.toMatchObject({ found: true });

  expect(delivered).toEqual(["first", "second"]);
});

it("strips the maximal suffix-prefix overlap from a no-epoch reset", async () => {
  const store = createStore([snapshot(["A", "B"]), snapshot(["B", "C"])]);
  await store.read(session.id);
  await store.read(session.id);
  expect(delivered).toEqual(["A", "B", "C"]);
});

it.each(["newer final rows", "an empty reset marker"])(
  "queues %s behind pending delivery",
  async (kind) => {
    const finalizing = kind === "newer final rows";
    const snapshots = finalizing
      ? [snapshot(["A"], "page-1"), snapshot(["A", "B"], "page-1")]
      : [snapshot(["A"]), snapshot([]), snapshot(["A", "B"])];
    unavailable = true;
    const store = createStore(snapshots);
    for (let index = 0, count = snapshots.length; index < count; index += 1) {
      const options = { finalize: finalizing && index === count - 1 };
      await expect(store.captureNotes(session, options)).rejects.toThrow("store unavailable");
    }
    unavailable = false;
    await store.flushPending(session);
    expect(delivered).toEqual(finalizing ? ["A", "B"] : ["A", "A", "B"]);
  },
);

it("preserves pending delivery when the final browser snapshot also fails", async () => {
  unavailable = true;
  const store = createStore([snapshot(["pending"]), new Error("browser snapshot unavailable")]);

  await expect(store.captureNotes(session)).rejects.toThrow("store unavailable");
  await expect(store.captureNotes(session, { finalize: true })).rejects.toMatchObject({
    finalCaptureError: "browser snapshot unavailable",
  });
});
