import { renameSync, statSync } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { isAgentDatabaseClosing } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../io.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as fixtures from "./session-transcript-reconcile.fixtures.test-support.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
} from "./session-transcript-reconcile.js";
import { holdReconcileAck } from "./session-transcript-reconcile.test-support.js";
import { messageEvent } from "./transcript-message.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);
const { observer, tempDirs } = fixtures.useReconcileTestRuntime();

async function fixture() {
  const stateDir = tempDirs.make("transcript-publication-");
  const { options, scope } = fixtures.reconcileScope(stateDir, "publication");
  setRuntimeConfigSnapshot({
    session: { store: resolveSessionStorePathCore(undefined, options) },
  });
  await fixtures.seedTranscript(scope, "message-0", "projection message 0");
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  const database = openOpenClawAgentDatabase(options);
  fixtures.markRebuild(database.db);
  return { options: { ...options, path: database.path }, scope, database };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.closeReconcileDatabases();
  clearRuntimeConfigSnapshot();
});

it("publishes a cold compressed multi-chunk branch without host data SQL", async () => {
  const { options, scope, database } = await fixture();
  const activeMessages = Array.from({ length: 520 }, (_, index) =>
    messageEvent(`message-${index}`, index === 0 ? null : `message-${index - 1}`, {
      role: "user",
      content:
        index === 0 ? "retained payload ".repeat(256).trimEnd() : `projection message ${index}`,
    }),
  );
  const events = [
    { type: "session", id: scope.sessionId, version: 3 },
    ...activeMessages,
    messageEvent("abandoned", "message-519", {
      role: "assistant",
      content: "abandoned payload ".repeat(256).trimEnd(),
    }),
    {
      type: "leaf",
      id: "rewind",
      parentId: "abandoned",
      targetId: "message-519",
      appendParentId: "message-519",
    },
  ];
  await replaceTranscriptEvents(scope, events);
  const sibling = { ...scope, sessionId: "sibling", sessionKey: "agent:main:sibling" };
  await fixtures.seedTranscript(sibling, "sibling-message", "untouched");
  await waitForSessionTranscriptIndexReconcilesInStateDir(options.env.OPENCLAW_STATE_DIR!);
  fixtures.expectRows(
    database.db,
    `SELECT seq, event_json IS NULL AS compressed,
        length(event_zstd) > 0 AND length(event_zstd) < event_utf8_bytes AS smaller,
        navigation_json IS NOT NULL AS navigation
        FROM transcript_events WHERE session_id = ? AND seq IN (1, 521) ORDER BY seq`,
    [
      { seq: 1, compressed: 1, smaller: 1, navigation: 1 },
      { seq: 521, compressed: 1, smaller: 1, navigation: 1 },
    ],
    scope.sessionId,
  );
  const canonical = readTranscriptEventRows(database, scope.sessionId);
  expect(canonical.map((event) => event.eventJson)).toEqual(
    events.map((event) => JSON.stringify(event)),
  );
  const physicalRows = (db: typeof database.db) =>
    fixtures.rows(
      db,
      `SELECT session_id, seq, created_at, event_json, hex(event_zstd) AS compressed_hex,
        event_utf8_bytes, navigation_json FROM transcript_events ORDER BY session_id, seq`,
    );
  const siblingProjection = (db: typeof database.db) =>
    fixtures.projectionSnapshot(db, sibling.sessionId);
  const physicalBefore = physicalRows(database.db);
  const siblingBefore = siblingProjection(database.db);
  fixtures.markRebuild(database.db, scope.sessionId);
  await fixtures.closeReconcileDatabases();
  const observed = observeHostDataSql();
  try {
    await fixtures.expectReconciled(reconcileSessionTranscriptIndexes(options));
    await fixtures.expectReconciled(reconcileSessionTranscriptIndexes(options), 0);
    await fixtures.closeReconcileDatabases();
    expect(observed.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    observed.restore();
  }
  const reopened = openOpenClawAgentDatabase(options);
  const { db } = reopened;
  expect(readTranscriptEventRows(reopened, scope.sessionId)).toEqual(canonical);
  expect(physicalRows(db)).toEqual(physicalBefore);
  expect(siblingProjection(db)).toEqual(siblingBefore);
  expect(
    fixtures.row(
      db,
      `SELECT needs_rebuild, active_message_count, leaf_event_id
        FROM session_transcript_index_state WHERE session_id = ?`,
      scope.sessionId,
    ),
  ).toEqual({ needs_rebuild: 0, active_message_count: 520, leaf_event_id: "message-519" });
  fixtures.expectRows(
    db,
    `SELECT identity.event_id FROM session_transcript_active_events active
        JOIN transcript_event_identities identity
          ON identity.session_id = active.session_id AND identity.seq = active.event_seq
        WHERE active.session_id = ? ORDER BY active.active_position`,
    activeMessages.map((event) => ({ event_id: event.id })),
    scope.sessionId,
  );
  fixtures.expectRows(
    db,
    "SELECT message_id, text FROM session_transcript_fts WHERE session_id = ? ORDER BY rowid",
    activeMessages.map((event) => ({ message_id: event.id, text: event.message.content })),
    scope.sessionId,
  );
  expect(fixtures.row(db, "SELECT count(*) AS count FROM session_transcript_fts_rows")).toEqual({
    count: 521,
  });
  // Check both directions: content alone can hide missing identities or stale FTS rows.
  fixtures.expectRows(
    db,
    `SELECT m.id FROM session_transcript_fts_rows m
        LEFT JOIN session_transcript_fts f ON f.rowid = m.id
        WHERE f.rowid IS NULL OR f.session_id IS NOT m.session_id OR f.message_id IS NOT m.message_id
        UNION ALL
        SELECT f.rowid FROM session_transcript_fts f
        LEFT JOIN session_transcript_fts_rows m ON m.id = f.rowid WHERE m.id IS NULL`,
    [],
  );
}, 30_000);

it("publishes the session change only after finalization commits", async () => {
  const { options, scope, database } = await fixture();
  const changes: unknown[] = [];
  const stop = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
      changes.push(fixtures.rebuildState(database.db));
    }
  });
  try {
    observer.onTask = ({ observeMessage }) => {
      observeMessage((message) => {
        if (message.type === "plan-start") {
          database.db.exec(`CREATE TRIGGER refuse_projection BEFORE UPDATE OF needs_rebuild
            ON session_transcript_index_state WHEN NEW.needs_rebuild = 0
            BEGIN SELECT RAISE(ABORT, 'fixture finalization refused'); END;`);
        }
      });
    };
    await expect(reconcileSessionTranscriptIndexes(options)).rejects.toThrow(
      "fixture finalization refused",
    );
    observer.onTask = undefined;
    expect(changes).toEqual([]);
    expect(fixtures.rebuildState(database.db)).toEqual({ needs_rebuild: 1 });
    database.db.exec("DROP TRIGGER refuse_projection");
    await fixtures.expectReconciled(reconcileSessionTranscriptIndexes(options));
    expect(changes).toEqual([{ needs_rebuild: 0 }]);
  } finally {
    stop();
  }
}, 30_000);

it("delivers a committed finalization before close permits a physical successor", async () => {
  const { options, scope, database } = await fixture();
  const originalFile = statSync(database.path, { bigint: true });
  const committed = createDeferred();
  const deliver = createDeferred();
  const events: string[] = [];
  const notifications: unknown[] = [];
  const stop = sessionChanges.subscribe((change) => {
    if (
      "sessionKey" in change &&
      change.sessionKey === scope.sessionKey &&
      change.storePath === database.path
    ) {
      events.push("notification");
      notifications.push({
        originalFile: statSync(database.path, { bigint: true }).ino === originalFile.ino,
        originalOpen: database.db.isOpen,
        state: database.db.isOpen ? fixtures.rebuildState(database.db) : undefined,
      });
    }
  });
  let held = false;
  const operationSpy = fixtures.interceptWorkerExecution(
    (execute) => async (command, commandOptions) => {
      const result = await execute(command, commandOptions);
      if (
        !held &&
        command.type === "database.domain.publish" &&
        isRecord(command.input) &&
        isRecord(command.input.command) &&
        command.input.command.type === "finalize"
      ) {
        held = true;
        expect(result).toMatchObject({ finalized: true, sessionKey: scope.sessionKey });
        events.push("committed");
        committed.resolve();
        await deliver.promise;
      }
      return result;
    },
  );
  let reconciliation: ReturnType<typeof reconcileSessionTranscriptIndexes> | undefined;
  let closing: Promise<boolean> | undefined;
  let replacing: Promise<typeof database> | undefined;
  try {
    reconciliation = reconcileSessionTranscriptIndexes(options);
    await awaitGateBeforeSettlement(
      committed.promise,
      reconciliation,
      "Reconciliation finished without holding its native finalizer reply",
    );
    expect(fixtures.rebuildState(database.db)).toEqual({ needs_rebuild: 0 });
    expect(fixtures.projectionMessages(database.db)).toEqual([
      { message_id: "message-0", text: "projection message 0" },
    ]);
    expect(notifications).toEqual([]);
    closing = closeOpenClawAgentDatabaseByPathAsync(database.path).then((closed) => {
      expect(closed).toBe(true);
      events.push("closed");
      return closed;
    });
    replacing = closing.then(async () => {
      renameSync(database.path, `${database.path}.retired`);
      const successor = openOpenClawAgentDatabase(options);
      expect(statSync(successor.path, { bigint: true }).ino).not.toBe(originalFile.ino);
      events.push("replaced");
      await fixtures.seedTranscript(
        { ...options, sessionId: "successor", sessionKey: "agent:main:successor" },
        "successor-message",
        "successor",
      );
      await waitForSessionTranscriptIndexReconcile(options);
      return successor;
    });
    expect(isAgentDatabaseClosing({ agentId: options.agentId, path: database.path })).toBe(true);
    expect(database.db.isOpen).toBe(true);
    expect(events).toEqual(["committed"]);
    deliver.resolve();
    await fixtures.expectReconciled(reconciliation);
    const successor = await replacing;
    expect(events).toEqual(["committed", "notification", "closed", "replaced"]);
    expect(notifications).toEqual([
      { originalFile: true, originalOpen: true, state: { needs_rebuild: 0 } },
    ]);
    expect(database.db.isOpen).toBe(false);
    expect(readTranscriptEventRows(successor, scope.sessionId)).toEqual([]);
    expect(fixtures.projectionMessages(successor.db)).toEqual([
      { message_id: "successor-message", text: "successor" },
    ]);
  } finally {
    deliver.resolve();
    await Promise.allSettled([reconciliation, closing, replacing]);
    stop();
    operationSpy.mockRestore();
  }
});

it("refuses a retired scheduled owner and permits an explicit fresh repair", async () => {
  const { options } = await fixture();
  startSessionTranscriptIndexReconcile(options);
  await closeOpenClawAgentDatabasesAsync();
  await waitForSessionTranscriptIndexReconcile(options);
  const { db } = openOpenClawAgentDatabase(options);
  expect(fixtures.rebuildState(db)).toEqual({ needs_rebuild: 1 });
  await fixtures.expectReconciled(reconcileSessionTranscriptIndexes(options));
  expect(fixtures.rebuildState(db)).toEqual({ needs_rebuild: 0 });
}, 30_000);

it("keeps a successor request separate from a retired scheduled owner", async () => {
  const { options, scope } = await fixture();
  const { paused, release } = holdReconcileAck(observer, "plan-finish");
  startSessionTranscriptIndexReconcile(options);
  try {
    await paused;
    const closing = closeOpenClawAgentDatabasesAsync();
    observer.onTask = undefined;
    release();
    await closing;
    const successor = openOpenClawAgentDatabase(options);
    fixtures.markRebuild(successor.db, scope.sessionId);
    startSessionTranscriptIndexReconcile(options);
    release();
    await waitForSessionTranscriptIndexReconcilesInStateDir(options.env.OPENCLAW_STATE_DIR!);
    expect(fixtures.rebuildState(successor.db)).toEqual({ needs_rebuild: 0 });
  } finally {
    release();
    await waitForSessionTranscriptIndexReconcile(options);
  }
}, 30_000);

it.each(["transcript", "caller", "cancellation"] as const)(
  "rejects prepared projection publication when %s authority changes",
  async (race) => {
    const { options, database, scope } = await fixture();
    const changes: unknown[] = [];
    let current = true;
    const controller = new AbortController();
    const refusal = new Error("startup maintenance owner retired");
    const stop = sessionChanges.subscribe((change) => changes.push(change));
    observer.onTask = ({ observeMessage }) =>
      observeMessage((message) => {
        if (message.type === "plan-start") {
          if (race === "transcript") {
            database.db
              .prepare(
                "UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?",
              )
              .run("replacement-generation", scope.sessionId);
          } else if (race === "caller") {
            current = false;
          } else {
            controller.abort(refusal);
          }
        }
      });
    try {
      const repair = reconcileSessionTranscriptIndexes({
        ...options,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw refusal;
          }
        },
      });
      if (race === "transcript") {
        await fixtures.expectReconciled(repair, 0);
      } else {
        await expect(repair).rejects.toThrow("startup maintenance owner retired");
      }
      expect(changes).toEqual([]);
      expect(fixtures.rebuildState(database.db)).toEqual({ needs_rebuild: 1 });
      expect(fixtures.projectionMessages(database.db)).toEqual([
        { message_id: "message-0", text: "projection message 0" },
      ]);
    } finally {
      stop();
    }
  },
  30_000,
);
