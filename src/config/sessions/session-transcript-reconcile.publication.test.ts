import { renameSync, statSync } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { captureAgentDatabaseCloseFence } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);
const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(count = 1) {
  const stateDir = tempDirs.make("transcript-publication-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const options = { agentId: "main", env };
  const scope = { ...options, sessionId: "publication", sessionKey: "agent:main:publication" };
  await persistSessionTranscriptTurn(scope, {
    messages: Array.from({ length: count }, (_, index) => ({
      eventId: `message-${index}`,
      message: { role: "user" as const, content: `projection message ${index}` },
    })),
    touchSessionEntry: false,
  });
  await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
  const database = openOpenClawAgentDatabase(options);
  database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
  return { options: { ...options, path: database.path }, scope, database };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

it("publishes a cold compressed multi-chunk branch without host data SQL", async () => {
  const { options, scope, database } = await fixture();
  const activeMessages = Array.from({ length: 520 }, (_, index) => ({
    type: "message",
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    message: {
      role: "user",
      content:
        index === 0 ? "retained payload ".repeat(256).trimEnd() : `projection message ${index}`,
    },
  }));
  const events = [
    { type: "session", id: scope.sessionId, version: 3 },
    ...activeMessages,
    {
      type: "message",
      id: "abandoned",
      parentId: "message-519",
      message: { role: "assistant", content: "abandoned payload ".repeat(256).trimEnd() },
    },
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
  await persistSessionTranscriptTurn(sibling, {
    messages: [{ eventId: "sibling-message", message: { role: "user", content: "untouched" } }],
    touchSessionEntry: false,
  });
  await waitForSessionTranscriptIndexReconcilesInStateDir(options.env.OPENCLAW_STATE_DIR!);
  expect(
    database.db
      .prepare(`SELECT seq, event_json IS NULL AS compressed,
        length(event_zstd) > 0 AND length(event_zstd) < event_utf8_bytes AS smaller,
        navigation_json IS NOT NULL AS navigation
        FROM transcript_events WHERE session_id = ? AND seq IN (1, 521) ORDER BY seq`)
      .all(scope.sessionId),
  ).toEqual([
    { seq: 1, compressed: 1, smaller: 1, navigation: 1 },
    { seq: 521, compressed: 1, smaller: 1, navigation: 1 },
  ]);
  const canonical = readTranscriptEventRows(database, scope.sessionId);
  expect(canonical.map((row) => row.eventJson)).toEqual(
    events.map((event) => JSON.stringify(event)),
  );
  const physicalRows = (db: typeof database.db) =>
    db
      .prepare(`SELECT session_id, seq, created_at, event_json, hex(event_zstd) AS compressed_hex,
        event_utf8_bytes, navigation_json FROM transcript_events ORDER BY session_id, seq`)
      .all();
  const siblingProjection = (db: typeof database.db) => ({
    index: db
      .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
      .get(sibling.sessionId),
    active: db
      .prepare(
        "SELECT * FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
      )
      .all(sibling.sessionId),
    fts: db
      .prepare(`SELECT CAST(m.id AS TEXT) AS id, m.message_id, f.text, f.role, f.timestamp
        FROM session_transcript_fts_rows m JOIN session_transcript_fts f ON f.rowid = m.id
        WHERE m.session_id = ? ORDER BY m.id`)
      .all(sibling.sessionId),
  });
  const physicalBefore = physicalRows(database.db);
  const siblingBefore = siblingProjection(database.db);
  database.db
    .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(scope.sessionId);
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const observed = observeHostDataSql(options.env);
  try {
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
      reconciledSessions: 1,
    });
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
      reconciledSessions: 0,
    });
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
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
    db
      .prepare(`SELECT needs_rebuild, active_message_count, leaf_event_id
        FROM session_transcript_index_state WHERE session_id = ?`)
      .get(scope.sessionId),
  ).toEqual({ needs_rebuild: 0, active_message_count: 520, leaf_event_id: "message-519" });
  expect(
    db
      .prepare(`SELECT identity.event_id FROM session_transcript_active_events active
        JOIN transcript_event_identities identity
          ON identity.session_id = active.session_id AND identity.seq = active.event_seq
        WHERE active.session_id = ? ORDER BY active.active_position`)
      .all(scope.sessionId),
  ).toEqual(activeMessages.map((event) => ({ event_id: event.id })));
  expect(
    db
      .prepare(
        "SELECT message_id, text FROM session_transcript_fts WHERE session_id = ? ORDER BY rowid",
      )
      .all(scope.sessionId),
  ).toEqual(activeMessages.map((event) => ({ message_id: event.id, text: event.message.content })));
  expect(db.prepare("SELECT count(*) AS count FROM session_transcript_fts_rows").get()).toEqual({
    count: 521,
  });
  // Check both directions: content alone can hide missing identities or stale FTS rows.
  expect(
    db
      .prepare(`SELECT m.id FROM session_transcript_fts_rows m
        LEFT JOIN session_transcript_fts f ON f.rowid = m.id
        WHERE f.rowid IS NULL OR f.session_id IS NOT m.session_id OR f.message_id IS NOT m.message_id
        UNION ALL
        SELECT f.rowid FROM session_transcript_fts f
        LEFT JOIN session_transcript_fts_rows m ON m.id = f.rowid WHERE m.id IS NULL`)
      .all(),
  ).toEqual([]);
}, 30_000);

it("publishes the session change only after finalization commits", async () => {
  const { options, scope, database } = await fixture();
  const changes: unknown[] = [];
  const stop = sessionChanges.subscribe((change) => {
    if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
      changes.push(
        database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
      );
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
    expect(
      database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
    ).toEqual({ needs_rebuild: 1 });
    database.db.exec("DROP TRIGGER refuse_projection");
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
      reconciledSessions: 1,
    });
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
        state: database.db.isOpen
          ? database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get()
          : undefined,
      });
    }
  });
  const runOperation = workerStore.runSqliteWorkerStoreOperation;
  let held = false;
  const operationSpy = vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (worker: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof runOperation>[2],
        assertCurrent?: Parameters<typeof runOperation>[3],
        createAdmission?: Parameters<typeof runOperation>[4],
        requireStateLifecycle?: Parameters<typeof runOperation>[5],
      ) =>
        runOperation(
          target,
          (worker) =>
            operation({
              execute: async (command, commandOptions) => {
                const result = await worker.execute(command, commandOptions);
                if (
                  !held &&
                  command.type === "database.domain.publish" &&
                  isRecord(command.input) &&
                  isRecord(command.input.command) &&
                  command.input.command.type === "finalize"
                ) {
                  held = true;
                  expect(result).toEqual({ finalized: true, sessionKey: scope.sessionKey });
                  events.push("committed");
                  committed.resolve();
                  await deliver.promise;
                }
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          createAdmission,
          requireStateLifecycle,
        ),
    );
  let reconciliation: ReturnType<typeof reconcileSessionTranscriptIndexes> | undefined;
  let closing: Promise<boolean> | undefined;
  let replacing: Promise<typeof database> | undefined;
  try {
    reconciliation = reconcileSessionTranscriptIndexes(options);
    await Promise.race([
      committed.promise,
      reconciliation.then(() => {
        throw new Error("Reconciliation finished without holding its native finalizer reply");
      }),
    ]);
    expect(
      database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
    ).toEqual({ needs_rebuild: 0 });
    expect(
      database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
    ).toEqual([{ message_id: "message-0", text: "projection message 0" }]);
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
      await persistSessionTranscriptTurn(
        { ...options, sessionId: "successor", sessionKey: "agent:main:successor" },
        {
          messages: [
            { eventId: "successor-message", message: { role: "user", content: "successor" } },
          ],
          touchSessionEntry: false,
        },
      );
      await waitForSessionTranscriptIndexReconcile(options);
      return successor;
    });
    expect(
      captureAgentDatabaseCloseFence({ agentId: options.agentId, path: database.path }),
    ).toBeDefined();
    expect(database.db.isOpen).toBe(true);
    expect(events).toEqual(["committed"]);
    deliver.resolve();
    await expect(reconciliation).resolves.toEqual({ reconciledSessions: 1 });
    const successor = await replacing;
    expect(events).toEqual(["committed", "notification", "closed", "replaced"]);
    expect(notifications).toEqual([
      { originalFile: true, originalOpen: true, state: { needs_rebuild: 0 } },
    ]);
    expect(database.db.isOpen).toBe(false);
    expect(readTranscriptEventRows(successor, scope.sessionId)).toEqual([]);
    expect(
      successor.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
    ).toEqual([{ message_id: "successor-message", text: "successor" }]);
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
  expect(db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get()).toEqual({
    needs_rebuild: 1,
  });
  await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
    reconciledSessions: 1,
  });
  expect(db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get()).toEqual({
    needs_rebuild: 0,
  });
}, 30_000);

it("keeps a successor request separate from a retired scheduled owner", async () => {
  const { options, scope } = await fixture();
  const paused = createDeferred();
  let release: (() => void) | undefined;
  observer.onTask = ({ port, observeMessage }) => {
    let finishing = false;
    observeMessage((message) => {
      finishing = message.type === "plan-finish";
    });
    const post = port.postMessage.bind(port);
    port.postMessage = (message, transferList) => {
      const postOptions = Array.isArray(transferList) ? { transfer: transferList } : transferList;
      if (finishing) {
        finishing = false;
        release = () => post(message, postOptions);
        paused.resolve();
        return;
      }
      post(message, postOptions);
    };
  };
  startSessionTranscriptIndexReconcile(options);
  try {
    await paused.promise;
    const closing = closeOpenClawAgentDatabasesAsync();
    observer.onTask = undefined;
    release?.();
    await closing;
    const successor = openOpenClawAgentDatabase(options);
    successor.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    startSessionTranscriptIndexReconcile(options);
    release?.();
    await waitForSessionTranscriptIndexReconcilesInStateDir(options.env.OPENCLAW_STATE_DIR!);
    expect(
      successor.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
    ).toEqual({ needs_rebuild: 0 });
  } finally {
    release?.();
    await waitForSessionTranscriptIndexReconcile(options);
  }
}, 30_000);

it("rejects a prepared projection from a replaced transcript generation", async () => {
  const { options, database, scope } = await fixture();
  const changes: unknown[] = [];
  const stop = sessionChanges.subscribe((change) => changes.push(change));
  observer.onTask = ({ observeMessage }) =>
    observeMessage((message) => {
      if (message.type === "plan-start") {
        database.db
          .prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
          .run("replacement-generation", scope.sessionId);
      }
    });
  try {
    await expect(reconcileSessionTranscriptIndexes(options)).resolves.toEqual({
      reconciledSessions: 0,
    });
    expect(changes).toEqual([]);
    expect(
      database.db.prepare("SELECT needs_rebuild FROM session_transcript_index_state").get(),
    ).toEqual({ needs_rebuild: 1 });
    expect(
      database.db.prepare("SELECT message_id, text FROM session_transcript_fts").all(),
    ).toEqual([{ message_id: "message-0", text: "projection message 0" }]);
  } finally {
    stop();
  }
}, 30_000);
