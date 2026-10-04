import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { publishSystemEventStoreResolver } from "../infra/system-event-ownership.js";
import {
  claimSystemEventTurn,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  acknowledgeSessionStateNotices,
  recordSessionStateEvent,
  sweepSessionStateWatchNotices,
} from "./session-state-events.js";
import {
  child,
  createDatabaseOptions,
  createWatcherSession,
  eventInput,
  nestedWatcher,
  readCursor,
  seedChild,
  watcher,
} from "./session-state-events.test-support.js";
import { enqueueSessionStateNotice } from "./session-state-notices.js";

type NoticeHandoff = {
  capture: Mock<
    typeof import("../auto-reply/reply/session-event-handoff.js").captureSessionEventTargetForHost
  >;
  enqueue: Mock<
    typeof import("../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
  >;
};

export function registerSessionStateNoticeHandoffCases(
  noticeHandoff: NoticeHandoff,
  cfg: OpenClawConfig,
) {
  it("freezes one notice watermark while material events continue", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    const first = recordSessionStateEvent(eventInput(), database)!;
    recordSessionStateEvent(eventInput(), database);
    const third = recordSessionStateEvent(eventInput(), database)!;

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(readCursor(database)).toEqual({
      last_seen_sequence: first.sequence - 1,
      notified_sequence: first.sequence,
      material_sequence: third.sequence,
    });
  });

  it("opens a fresh notice for material work interleaved before ack", async () => {
    const database = createDatabaseOptions();
    seedChild(database);
    const frozen = recordSessionStateEvent(eventInput(), database)!;
    const interleaved = recordSessionStateEvent(eventInput(), database)!;
    const watcherStorePath = peekSystemEventEntries(watcher)[0]?.sessionStorePath ?? null;
    resetSystemEventsForTest();

    const parentStatements = trackSqliteStatementExecutions(
      openOpenClawStateDatabase(database).db,
      ["cursors"],
      (sql) => (/\bsession_watch_cursors\b/.test(sql) ? "cursors" : null),
    );
    try {
      await acknowledgeSessionStateNotices(
        watcher,
        [{ targetSessionKey: child, watcherStorePath }],
        database,
      );
    } finally {
      parentStatements.restore();
    }
    expect(parentStatements.counts.cursors).toBe(0);

    expect(readCursor(database)).toEqual({
      last_seen_sequence: frozen.sequence,
      notified_sequence: interleaved.sequence,
      material_sequence: interleaved.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(peekSystemEventEntries(watcher)[0]?.text).toContain(`changesSince ${frozen.sequence}`);
  });

  it("does not reopen an acked notice for log-only events or during sweep", async () => {
    const database = createDatabaseOptions();
    await createWatcherSession(database);
    seedChild(database);
    const material = recordSessionStateEvent(eventInput(), database)!;
    recordSessionStateEvent(
      eventInput({ kind: "run_completed", actorType: "system", runId: "run-log-only" }),
      database,
    );
    const watcherStorePath = peekSystemEventEntries(watcher)[0]?.sessionStorePath ?? null;
    resetSystemEventsForTest();

    await acknowledgeSessionStateNotices(
      watcher,
      [{ targetSessionKey: child, watcherStorePath }],
      database,
    );
    expect(readCursor(database)).toEqual({
      last_seen_sequence: material.sequence,
      notified_sequence: material.sequence,
      material_sequence: material.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toEqual([]);

    await sweepSessionStateWatchNotices(database);
    expect(peekSystemEventEntries(watcher)).toEqual([]);
  });

  it("hands active watcher notices to ordinary turns while nested notices remain passive", async () => {
    vi.useFakeTimers();
    const database = createDatabaseOptions();
    seedChild(database, nestedWatcher);

    recordSessionStateEvent(eventInput({ watcherSessionKeys: [nestedWatcher] }), database);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(1);
    expect(noticeHandoff.capture).not.toHaveBeenCalled();
    expect(noticeHandoff.enqueue).not.toHaveBeenCalled();

    seedChild(database, watcher);
    recordSessionStateEvent(eventInput(), database);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(noticeHandoff.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`Session "${child}" changed`),
      expect.objectContaining({
        source: "session",
        sessionKey: watcher,
        occurrence: peekSystemEventEntries(watcher)[0],
      }),
    );
  });

  it("coalesces repeated notices without dropping distinct pending watermarks", async () => {
    vi.useFakeTimers();
    publishSystemEventStoreResolver(() => "/notice/original.sqlite");
    const notice = {
      watcherSessionKey: watcher,
      watcherStorePath: "/notice/original.sqlite",
      targetSessionKey: child,
      lastSeenSequence: 1,
    };
    enqueueSessionStateNotice(notice);
    await vi.advanceTimersByTimeAsync(10_000);
    const original = peekSystemEventEntries(watcher)[0];
    enqueueSessionStateNotice(notice);
    enqueueSessionStateNotice({ ...notice, lastSeenSequence: 4 });
    const later = peekSystemEventEntries(watcher)[1];
    expect(later?.id).not.toBe(original?.id);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(noticeHandoff.enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(noticeHandoff.enqueue).toHaveBeenCalledTimes(2);
    expect(noticeHandoff.enqueue).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("changesSince 1"),
      expect.objectContaining({ sessionKey: watcher, occurrence: original }),
    );
    expect(noticeHandoff.enqueue).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("changesSince 4"),
      expect.objectContaining({ sessionKey: watcher, occurrence: later }),
    );
  });

  it("acknowledges adopted notices without cancelling their claimed occurrence when a followup is due", async () => {
    vi.useFakeTimers();
    const database = createDatabaseOptions();
    seedChild(database);
    const frozen = recordSessionStateEvent(eventInput(), database)!;
    const interleaved = recordSessionStateEvent(eventInput(), database)!;
    const completion = createDeferred<{
      status: "completed";
      executionStarted: boolean;
      delivered: boolean;
    }>();
    noticeHandoff.enqueue.mockImplementationOnce((_text, options) => ({
      id: options.occurrence!.id!,
      cancel: () => false,
      settled: completion.promise,
    }));
    const cancelled = vi.fn();
    let owner: ReturnType<typeof claimSystemEventTurn>;
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      const handoff = noticeHandoff.enqueue.mock.calls[0]?.[1];
      expect(handoff?.occurrence).toBeDefined();
      if (!handoff?.occurrence) {
        throw new Error("Expected the frozen notice handoff");
      }
      owner = claimSystemEventTurn(watcher, handoff.occurrence, cancelled, "main");
      expect(owner).toBeDefined();
      await handoff.onAdopted?.();

      expect(readCursor(database)).toEqual({
        last_seen_sequence: frozen.sequence,
        notified_sequence: interleaved.sequence,
        material_sequence: interleaved.sequence,
      });
      expect(cancelled).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(watcher)).toHaveLength(2);
      owner?.start();
      expect(peekSystemEventEntries(watcher)[0]?.text).toContain(`changesSince ${frozen.sequence}`);
      expect(cancelled).not.toHaveBeenCalled();
    } finally {
      owner?.cancel();
      completion.resolve({ status: "completed", executionStarted: true, delivered: false });
    }
  });

  it("does not acknowledge a replacement watcher store while worker admission is pending", async () => {
    const database = createDatabaseOptions();
    seedChild(database);
    recordSessionStateEvent(eventInput(), database);
    const before = readCursor(database);
    const originalPath = peekSystemEventEntries(watcher)[0]?.sessionStorePath;
    expect(originalPath).toBeTruthy();
    publishSystemEventStoreResolver(() => originalPath!);
    const acknowledgement = acknowledgeSessionStateNotices(
      watcher,
      [{ targetSessionKey: child, watcherStorePath: originalPath ?? null }],
      database,
    );
    publishSystemEventStoreResolver(() => "/notice/replacement.sqlite");

    await acknowledgement;

    expect(readCursor(database)).toEqual(before);
    expect(peekSystemEventEntries(watcher)).toEqual([]);
    expect(noticeHandoff.enqueue).not.toHaveBeenCalled();
  });

  it.each(["user drain", "store replacement"] as const)(
    "does not recreate a debounced notice after %s removed its occurrence",
    async (change) => {
      vi.useFakeTimers();
      createDatabaseOptions();
      publishSystemEventStoreResolver(() => "/notice/original.sqlite");
      enqueueSessionStateNotice({
        watcherSessionKey: watcher,
        watcherStorePath: "/notice/original.sqlite",
        targetSessionKey: child,
        lastSeenSequence: 1,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      if (change === "user drain") {
        await drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: watcher,
          isMainSession: false,
          isNewSession: false,
        });
      } else {
        publishSystemEventStoreResolver(() => "/notice/replacement.sqlite");
      }
      await vi.advanceTimersByTimeAsync(20_000);

      expect(noticeHandoff.enqueue).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(watcher)).toEqual([]);
    },
  );
}
