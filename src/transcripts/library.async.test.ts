import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { activeSessions } from "./capture.js";
import { exportTranscriptLibrary, getTranscriptLibrary, listTranscriptLibrary } from "./library.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptsStore, transcriptSessionSelector } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  activeSessions.clear();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const stateDir = tempDirs.make("transcript-library-async-");
  return {
    store: new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    }),
  };
}

function session(
  sessionId: string,
  overrides: Partial<TranscriptSessionDescriptor> = {},
): TranscriptSessionDescriptor {
  return {
    sessionId,
    title: sessionId,
    source: { providerId: "manual-transcript" },
    startedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("transcript library asynchronous reads", () => {
  it.each(["get", "export"] as const)(
    "keeps a delayed composed %s response coherent after a peer update",
    async (kind) => {
      const { store } = fixture();
      const target = session("delayed-read", { title: "Original meeting" });
      const utterance = { text: "Original saved note" };
      await store.writeSession(target);
      await store.appendUtteranceForSession(target, utterance);
      await store.writeSummary(
        summarizeTranscripts({ session: target, utterances: [utterance] }),
        target,
      );
      const selector = transcriptSessionSelector(target);
      const gate = createDeferred();
      const reading = createDeferred();
      if (kind === "get") {
        const read = store.readLibraryEntry.bind(store);
        vi.spyOn(store, "readLibraryEntry").mockImplementationOnce(async (...args) => {
          const snapshot = await read(...args);
          reading.resolve();
          await gate.promise;
          return snapshot;
        });
      } else {
        const iterate = store.iterateExport.bind(store);
        vi.spyOn(store, "iterateExport").mockImplementationOnce(async function* (...args) {
          const snapshot = yield* iterate(...args);
          reading.resolve();
          await gate.promise;
          return snapshot;
        });
      }
      const read = async () =>
        kind === "get"
          ? JSON.stringify(
              await getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 1 }),
            )
          : Buffer.from(
              (await exportTranscriptLibrary(store, { selector, format: "markdown" })).data,
              "base64",
            ).toString("utf8");
      let settled = false;
      const result = read();
      const settlement = result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const replacement = { ...target, title: "Replacement meeting" };
      const added = { text: "Peer saved note" };
      try {
        await reading.promise;
        await setImmediate();
        expect(settled).toBe(false);
        await store.writeSession(replacement);
        await store.appendUtteranceForSession(replacement, added);
        await store.writeSummary(
          summarizeTranscripts({ session: replacement, utterances: [utterance, added] }),
          replacement,
        );
      } finally {
        gate.resolve();
        await settlement;
      }
      const text = await result;
      expect(text).toContain("## Overview");
      expect(text).toContain(target.title);
      expect(text).toContain(utterance.text);
      expect(text).not.toContain(replacement.title);
      expect(text).not.toContain(added.text);
      expect((await store.readSession(selector))?.title).toBe(replacement.title);
      expect(await store.readUtterancesForSession(replacement)).toMatchObject([utterance, added]);
    },
  );

  it.each(["get", "export"] as const)(
    "propagates a failed composed %s without returning partial content",
    async (kind) => {
      const { store } = fixture();
      const target = session("rejected-read");
      await store.writeSession(target);
      const failure = new Error("archive read failed");
      const selector = transcriptSessionSelector(target);
      if (kind === "get") {
        vi.spyOn(store, "readLibraryEntry").mockRejectedValueOnce(failure);
        await expect(
          getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 1 }),
        ).rejects.toBe(failure);
      } else {
        vi.spyOn(store, "iterateExport").mockImplementationOnce(async function* () {
          yield { sequence: 0, text: "Partial content" };
          throw failure;
        });
        await expect(exportTranscriptLibrary(store, { selector, format: "jsonl" })).rejects.toBe(
          failure,
        );
      }
    },
  );

  it("rejects an export canceled before its completion result", async () => {
    const { store } = fixture();
    vi.spyOn(store, "iterateExport").mockImplementationOnce(async function* () {
      yield { sequence: 0, text: "Partial content" };
      return undefined;
    });
    await expect(
      exportTranscriptLibrary(store, { selector: "canceled", format: "jsonl" }),
    ).rejects.toThrow("export ended before completion");
  });

  it("awaits asynchronous page cleanup when public projection fails", async () => {
    const { store } = fixture();
    await store.writeSession(session("projection-failure"));
    const iterateReadEntries = store.iterateReadEntries.bind(store);
    const cleanup = createDeferred();
    const closing = createDeferred();
    let closed = false;
    vi.spyOn(store, "iterateReadEntries").mockImplementation(async function* (options) {
      try {
        return yield* iterateReadEntries(options);
      } finally {
        closing.resolve();
        await cleanup.promise;
        closed = true;
      }
    });
    const failure = new Error("provider projection failed");
    const result = listTranscriptLibrary(store, {}, () => {
      throw failure;
    });
    let settled = false;
    const settlement = result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await closing.promise;
      await setImmediate();
      expect(settled).toBe(false);
      expect(closed).toBe(false);
    } finally {
      cleanup.resolve();
      await settlement;
    }
    await expect(result).rejects.toBe(failure);
    expect(closed).toBe(true);
  });

  it("distinguishes historical unstopped rows from exact live subscriptions and stopping captures", async () => {
    const { store } = fixture();
    const old = session("reused");
    const current = session("reused", { startedAt: "2026-08-21T10:00:00.000Z" });
    await store.writeSession(old);
    await store.writeSession(current);
    activeSessions.set(current.sessionId, {
      session: current,
      phase: "active",
      provider: {},
      providerId: current.source.providerId,
    });
    const first = await listTranscriptLibrary(store, {});
    expect(first.sessions.map((entry) => entry.activeSubscription)).toEqual([true, false]);
    activeSessions.get(current.sessionId)!.stopping = true;
    expect(
      (await getTranscriptLibrary(store, { selector: transcriptSessionSelector(current) })).session
        .activeSubscription,
    ).toBe(false);
    const capture = activeSessions.get(current.sessionId)!;
    delete capture.stopping;
    capture.phase = "terminal";
    expect(
      (await listTranscriptLibrary(store, {})).sessions.every((entry) => !entry.activeSubscription),
    ).toBe(true);
    activeSessions.clear();
    expect(
      (await listTranscriptLibrary(store, {})).sessions.every(
        (entry) => !entry.activeSubscription && entry.stoppedAt === undefined,
      ),
    ).toBe(true);
  });
});
