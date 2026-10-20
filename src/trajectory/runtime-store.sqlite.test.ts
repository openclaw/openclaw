import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  readSqliteDatabaseScopedWriteToken,
  sqliteSessionIdWriteScope,
} from "../infra/sqlite-database-admission.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationContext } from "../infra/sqlite-worker-operation-settlement.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { createAgentWorkerTestLoaders } from "../state/openclaw-agent-execution-operations.test-support.js";
import type { AgentWorkerOperationContext } from "../state/openclaw-agent-operation-context.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { beginTrajectoryRuntimeRetention } from "./runtime-retention.sqlite.js";
import type { SqliteTrajectoryRuntimeAppend } from "./runtime-store.contract.js";
import {
  appendSqliteTrajectoryRuntimeEventsWithWriter,
  loadSqliteTrajectoryRuntimeEventRowsSync,
  loadSqliteTrajectoryRuntimeEvents,
} from "./runtime-store.sqlite.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  appendSerializedTrajectoryRuntimeEvents,
  createTrajectoryEvent,
} from "./runtime-store.test-support.js";
import type { TrajectoryEvent } from "./types.js";

type TrajectoryRuntimeTestDatabase = Pick<OpenClawAgentKyselyDatabase, "trajectory_runtime_events">;

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-trajectory-sqlite-");

let tempDir: string;
let storePath: string;

function useStore(sessionKey: string) {
  beforeEach(async () => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId: "session-1", updatedAt: 10 });
  });
}

function sqlitePath() {
  return path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
}

function openDatabase() {
  return openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
}

function readRows(
  options: Omit<
    Parameters<typeof loadSqliteTrajectoryRuntimeEventRowsSync>[0],
    "sessionId" | "storePath"
  > = {},
) {
  return loadSqliteTrajectoryRuntimeEventRowsSync({
    sessionId: "session-1",
    storePath,
    ...options,
  });
}

function readEvents() {
  return loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath });
}

function appendEvents(
  events: TrajectoryEvent[],
  options: Pick<SqliteTrajectoryRuntimeAppend, "maxRuntimeBytes" | "discardPrevious"> = {},
) {
  appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath, ...options }, events);
}

function eventBytes(events: TrajectoryEvent[], initial = 0) {
  return events.reduce(
    (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
    initial,
  );
}

function serialized(event: TrajectoryEvent) {
  return { runId: event.runId, ts: event.ts, line: JSON.stringify(event) };
}

function trackInserts(database: ReturnType<typeof openDatabase>) {
  return trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["insert"],
    (sql) => (/^insert into "trajectory_runtime_events"/i.test(sql) ? "insert" : null),
  );
}

async function seedEncoding(encoding: string) {
  if (encoding === "UTF-8") {
    return;
  }
  storePath = path.join(tempDir, `${encoding}.sqlite`);
  const seed = new DatabaseSync(storePath);
  try {
    seed.exec(
      `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
    );
  } finally {
    seed.close();
  }
  await replaceSessionEntry(
    { sessionKey: "agent:main:main", storePath },
    { sessionId: "session-1", updatedAt: 10 },
  );
}

describe("SQLite trajectory runtime store", () => {
  useStore("agent:main:main");

  async function workerAppend(busyTimeoutMs?: number) {
    const options = { agentId: "main", path: sqlitePath() };
    const database = openOpenClawAgentDatabase(options);
    const context: AgentWorkerOperationContext = {
      options,
      open: () => database,
      admit() {},
      writeTransaction: (operationLabel, _owner, write, _diagnostic, singleStatement) =>
        runOpenClawAgentWriteTransaction(write, options, {
          operationLabel,
          singleStatement,
          busyTimeoutMs,
        }),
    };
    const operations = await createAgentWorkerTestLoaders(context)["trajectory.events.append"]();
    const event = createTrajectoryEvent({ type: "terminal-insert" });
    const input: SqliteTrajectoryRuntimeAppend = {
      sessionId: "session-1",
      windowFacts: { nextSeq: 0, retainedBytes: 0 },
      events: [serialized(event)],
    };
    const append = () => {
      const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
      const owner: SqliteWorkerOperationContext = { port: admission.port };
      try {
        const window = withSqliteWorkerOperationAdmission(owner, () =>
          operations["trajectory.events.append"](input, context),
        );
        return { owner, window };
      } finally {
        admission.finish();
      }
    };
    return { options, database, context, input, append, operations, event };
  }

  it("publishes the prepared append receipt after one autocommit INSERT and uses its next window", async () => {
    const { database, input, append, event } = await workerAppend();
    const controls = vi.spyOn(database.db, "exec");
    const counter = trackInserts(database);
    try {
      const first = append();
      expect(first.owner.committed).toEqual({
        facts: {
          kind: "trajectory-runtime-append",
          sessionId: "session-1",
          appendedRange: { firstSeq: 0, lastSeq: 0 },
          removedThroughSeq: undefined,
          windowFacts: first.window,
        },
      });
      input.windowFacts = first.window;
      expect(append().owner.committed).toMatchObject({
        facts: { appendedRange: { firstSeq: 1, lastSeq: 1 } },
      });
      expect(counter.counts.insert).toBe(2);
      expect(controls).not.toHaveBeenCalled();
    } finally {
      controls.mockRestore();
      counter.restore();
    }
    expect(readRows()).toEqual([
      { seq: 0, event },
      { seq: 1, event },
    ]);
  });

  it("refuses receipt capture and final admission before attempting the terminal INSERT", async () => {
    const { database, context, input, append, operations } = await workerAppend();
    const counter = trackInserts(database);
    try {
      expect(() => operations["trajectory.events.append"](input, context)).toThrow(/receipt/i);
      context.admit = () => {
        throw new Error("append revoked");
      };
      expect(append).toThrow("append revoked");
      expect(counter.counts.insert).toBe(0);
    } finally {
      counter.restore();
    }
    expect(readRows()).toEqual([]);
  });

  it.each(["statement", "lock"])(
    "keeps a failed %s unpublished and permits a later append",
    async (failure) => {
      const { database, context, input, operations, append, event } = await workerAppend(0);
      const blocker = openNodeSqliteDatabase(sqlitePath());
      const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
      const owner: SqliteWorkerOperationContext = { port: admission.port };
      if (failure === "lock") {
        blocker.exec("BEGIN IMMEDIATE");
      } else {
        database.db
          .exec(`CREATE TEMP TRIGGER reject_terminal_append BEFORE INSERT ON trajectory_runtime_events
        BEGIN SELECT RAISE(ABORT, 'terminal insert rejected'); END`);
      }
      try {
        expect(() =>
          withSqliteWorkerOperationAdmission(owner, () =>
            operations["trajectory.events.append"](input, context),
          ),
        ).toThrow(failure === "lock" ? /locked|busy/i : "terminal insert rejected");
        expect(owner.committed).toBeUndefined();
      } finally {
        if (failure === "lock") {
          blocker.exec("ROLLBACK");
        } else {
          database.db.exec("DROP TRIGGER reject_terminal_append");
        }
        blocker.close();
        admission.finish();
      }
      expect(append().window.nextSeq).toBe(1);
      expect(readRows()).toEqual([{ seq: 0, event }]);
    },
  );

  it.each(["unknown window", "large batch", "pruning", "retention"])(
    "rolls back refused %s work as a transaction",
    async (kind) => {
      const { database, context, input, append } = await workerAppend();
      const lease = new Int32Array(new SharedArrayBuffer(4));
      if (kind === "unknown window") {
        input.windowFacts = undefined;
      }
      if (kind === "large batch") {
        input.events = Array.from({ length: 33 }, () => input.events[0]!);
      }
      if (kind === "pruning") {
        input.maxRuntimeBytes = 1;
      }
      if (kind === "retention") {
        Atomics.store(lease, 0, 1);
        beginTrajectoryRuntimeRetention(database.db, lease);
      }
      context.admit = () => {
        throw new Error("append revoked");
      };
      const controls = vi.spyOn(database.db, "exec");
      try {
        expect(append).toThrow("append revoked");
        expect(controls).toHaveBeenCalledWith("BEGIN IMMEDIATE");
        expect(controls).toHaveBeenCalledWith("ROLLBACK");
      } finally {
        controls.mockRestore();
        Atomics.store(lease, 0, 0);
      }
      expect(readRows()).toEqual([]);
    },
  );

  it("reads mixed payloads through the worker operation and preserves byte limits, cursors and rollback", async () => {
    const { options, database, context, operations } = await workerAppend();
    const db = getNodeSqliteKysely<TrajectoryRuntimeTestDatabase>(database.db);
    const legacyEvent = createTrajectoryEvent({ type: "legacy", payloadSize: 4096 });
    const events = [
      legacyEvent,
      ...["first", "second", "third"].map((type) =>
        createTrajectoryEvent({ type, payloadSize: 4096 }),
      ),
    ];
    runOpenClawAgentWriteTransaction((current) => {
      executeSqliteQuerySync(
        current.db,
        db.insertInto("trajectory_runtime_events").values({
          session_id: "session-1",
          seq: 0,
          run_id: "run-1",
          event_json: JSON.stringify(legacyEvent),
          created_at: Date.parse(legacyEvent.ts),
        }),
      );
    }, options);
    let rejectCommit = false;
    context.admit = (stage) => {
      if (rejectCommit && stage === "commit") {
        throw new Error("synthetic commit rejection");
      }
    };
    const append = (batch: TrajectoryEvent[], maxRuntimeBytes?: number) => {
      const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
      try {
        return withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
          operations["trajectory.events.append"](
            {
              sessionId: "session-1",
              maxRuntimeBytes,
              events: batch.map((event) => ({
                runId: event.runId,
                ts: event.ts,
                get line() {
                  expect(database.db.isTransaction).toBe(false);
                  return JSON.stringify(event);
                },
              })),
            },
            context,
          ),
        );
      } finally {
        admission.finish();
      }
    };
    append(events.slice(1, 3));
    expect(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("trajectory_runtime_events").select("event_codec").orderBy("seq"),
      ).rows,
    ).toEqual([{ event_codec: null }, { event_codec: "br" }, { event_codec: "br" }]);
    await expect(readEvents()).resolves.toEqual(events.slice(0, 3));
    const maxEventBytes = eventBytes(events.slice(0, 3), -1);
    expect(readRows({ maxEventBytes })).toHaveLength(3);
    expect(readRows({ maxEventCount: 3 })).toHaveLength(3);
    expect(() => readRows({ maxEventBytes: maxEventBytes - 1 })).toThrow(/too large to export/);
    expect(() => readRows({ maxEventCount: 2 })).toThrow(/too many events/);
    expect(readRows({ afterSeq: 0, maxEvents: 1 })).toEqual([{ seq: 1, event: events[1] }]);
    expect(readRows({ tailEvents: 1 })).toEqual([{ seq: 2, event: events[2] }]);
    expect(readRows({ tailEvents: 3, maxEvents: 1 })).toEqual([{ seq: 2, event: events[2] }]);
    rejectCommit = true;
    expect(() => append(events.slice(3))).toThrow("synthetic commit rejection");
    rejectCommit = false;
    expect(readRows()).toHaveLength(3);
    const maxRuntimeBytes = eventBytes(events.slice(2));
    append(events.slice(3), maxRuntimeBytes);
    expect(readRows()).toEqual([
      { seq: 2, event: events[2] },
      { seq: 3, event: events[3] },
    ]);
  });

  it("appends serialized batches in database order without trusting recorder-local seq", async () => {
    const events = Array.from({ length: 201 }, (_, index) =>
      createTrajectoryEvent({ seq: 1, type: `event-${index}` }),
    );
    const database = openDatabase();
    Object.defineProperty(events[0], "toJSON", {
      value: () => {
        expect(database.db.isTransaction).toBe(false);
        return { ...events[0] };
      },
    });
    const counter = trackInserts(database);
    try {
      appendSerializedTrajectoryRuntimeEvents(
        { sessionId: "session-1", storePath },
        events.map(serialized),
      );
      expect(counter.counts.insert).toBeLessThan(10);
    } finally {
      counter.restore();
    }
    await expect(readEvents()).resolves.toEqual(events);
    const db = getNodeSqliteKysely<TrajectoryRuntimeTestDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("trajectory_runtime_events")
        .select(["seq", "run_id", "event_json"])
        .where("session_id", "=", "session-1")
        .orderBy("seq", "asc"),
    ).rows;
    expect(rows).toEqual(
      events.map((event, seq) => ({ run_id: "run-1", seq, event_json: JSON.stringify(event) })),
    );
  });

  it.each(["session-1", "session-2"])(
    "keeps transcript receipts current across trajectory append and trimming for %s",
    async (sessionId) => {
      await replaceSessionEntry(
        { sessionKey: "agent:main:other", storePath },
        { sessionId: "session-2", updatedAt: 10 },
      );
      const options = { agentId: "main", path: sqlitePath() };
      const database = openOpenClawAgentDatabase(options);
      const scopes = [
        "agent:main:main",
        "agent:main:other",
        sqliteSessionIdWriteScope("session-1"),
        sqliteSessionIdWriteScope("session-2"),
      ];
      const token = readSqliteDatabaseScopedWriteToken(database.db, scopes);
      expect(token).toBeTypeOf("string");
      const append = (types: string[], discardPrevious?: boolean, maxRuntimeBytes?: number) =>
        appendSqliteTrajectoryRuntimeEventsWithWriter(
          {
            sessionId,
            discardPrevious,
            maxRuntimeBytes,
            events: types.map((type) => serialized(createTrajectoryEvent({ sessionId, type }))),
          },
          database,
          (operationLabel, write) =>
            runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
        ).receipt;
      const expectReceipt = (
        types: string[],
        firstSeq: number,
        removedThroughSeq?: number,
        discardPrevious?: boolean,
        maxRuntimeBytes?: number,
      ) => {
        expect(append(types, discardPrevious, maxRuntimeBytes)).toEqual({
          kind: "trajectory-runtime-append",
          sessionId,
          appendedRange: { firstSeq, lastSeq: firstSeq + types.length - 1 },
          removedThroughSeq,
          windowFacts: {
            nextSeq: firstSeq + types.length,
            retainedBytes: eventBytes(
              types.map((type) => createTrajectoryEvent({ sessionId, type })),
            ),
          },
        });
      };
      expectReceipt(["first", "second"], 0);
      expectReceipt(["third", "fourth"], 2, 1, true);
      const last = createTrajectoryEvent({ sessionId, type: "last" });
      expectReceipt(["last"], 4, 3, false, Buffer.byteLength(JSON.stringify(last), "utf8") + 1);
      expect(readSqliteDatabaseScopedWriteToken(database.db, scopes)).toBe(token);
      expect(loadSqliteTrajectoryRuntimeEventRowsSync({ sessionId, storePath })).toEqual([
        { seq: 4, event: last },
      ]);
    },
  );

  it("uses committed window facts until actual byte overflow needs the SQL suffix", () => {
    const options = { agentId: "main", path: sqlitePath() };
    const database = openOpenClawAgentDatabase(options);
    const events = ["first🦞", "later🦞", "final🦞"].map((type) => createTrajectoryEvent({ type }));
    const maxRuntimeBytes = eventBytes(events.slice(0, 2));
    const append = (
      event: TrajectoryEvent,
      windowFacts?: { nextSeq: number; retainedBytes: number },
    ) =>
      appendSqliteTrajectoryRuntimeEventsWithWriter(
        {
          sessionId: "session-1",
          maxRuntimeBytes,
          windowFacts,
          events: [serialized(event)],
        },
        database,
        (operationLabel, write) =>
          runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
      ).receipt.windowFacts;
    const first = append(events[0]!);
    let committed = first;
    const counter = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["window"],
      (sql) =>
        /^select\b/i.test(sql) && sql.includes('"trajectory_runtime_events"') ? "window" : null,
    );
    try {
      const second = append(events[1]!, first);
      expect(counter.counts.window).toBe(0);
      expect(second).toEqual({ nextSeq: 2, retainedBytes: maxRuntimeBytes });
      committed = append(events[2]!, second);
      expect(committed).toEqual({ nextSeq: 3, retainedBytes: maxRuntimeBytes });
      expect(counter).toMatchObject({ counts: { window: 1 }, textBytes: { window: 0 } });
    } finally {
      counter.restore();
    }
    expect(readRows()).toEqual(events.slice(1).map((event, index) => ({ event, seq: index + 1 })));
    const empty = append(
      createTrajectoryEvent({ type: "oversized", payloadSize: maxRuntimeBytes }),
      committed,
    );
    expect(empty).toEqual({ nextSeq: 0, retainedBytes: 0 });
    expect(append(events[0]!, empty)).toEqual({
      nextSeq: 1,
      retainedBytes: Buffer.byteLength(JSON.stringify(events[0]), "utf8") + 1,
    });
    expect(readRows()).toEqual([{ event: events[0], seq: 0 }]);
  });

  it("rolls back a later batch failure and retries without losing or duplicating events", async () => {
    const existing = createTrajectoryEvent({ type: "existing" });
    appendEvents([existing]);
    const events = Array.from({ length: 100 }, (_, index) =>
      createTrajectoryEvent({ type: `pending-${index}` }),
    );
    const database = openDatabase();
    database.db.exec(`CREATE TEMP TRIGGER reject_trajectory_append
      BEFORE INSERT ON trajectory_runtime_events WHEN NEW.seq = 65
      BEGIN SELECT RAISE(ABORT, 'synthetic later append failure'); END`);
    try {
      expect(() => appendEvents(events)).toThrow("synthetic later append failure");
      await expect(readEvents()).resolves.toEqual([existing]);
    } finally {
      database.db.exec("DROP TRIGGER reject_trajectory_append");
    }
    appendEvents(events);
    expect(readRows()).toEqual([existing, ...events].map((event, seq) => ({ event, seq })));
  });

  it.each(["0", "1969-12-31T23:59:59.000Z"])(
    "stores Date.parse-compatible trajectory timestamp %s",
    (timestamp) => {
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
        createTrajectoryEvent({ ts: timestamp, type: "timestamp-contract" }),
      ]);

      const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
      const db = getNodeSqliteKysely<TrajectoryRuntimeTestDatabase>(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("trajectory_runtime_events")
          .select(["created_at"])
          .where("session_id", "=", "session-1"),
      ).rows;
      expect(rows).toEqual([{ created_at: Date.parse(timestamp) }]);
    },
  );

  it("rejects a foreign owner for a non-shared agent store on append and read", async () => {
    const foreign = { agentId: "ops", sessionId: "session-1", storePath };
    expect(() =>
      appendSqliteTrajectoryRuntimeEvents(foreign, [createTrajectoryEvent({ type: "foreign" })]),
    ).toThrow(/store path belongs to agent main; requested agent ops/);
    expect(() => loadSqliteTrajectoryRuntimeEventRowsSync(foreign)).toThrow(
      /store path belongs to agent main; requested agent ops/,
    );
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1", storePath }),
    ).resolves.toEqual([]);
  });

  it.each(
    ["UTF-8", "UTF-16le", "UTF-16be"].flatMap((encoding) =>
      [0, -1].map((delta) => ({ encoding, delta })),
    ),
  )(
    "keeps the UTF-8 byte window in $encoding with a $delta-byte adjustment",
    async ({ encoding, delta }) => {
      await seedEncoding(encoding);
      const events = ["old", "middle", "newest"].map((type) => {
        const event = createTrajectoryEvent({ type });
        event.data = { payload: "日本語🦞".repeat(100) };
        return event;
      });
      const maxRuntimeBytes = eventBytes(events.slice(-2), delta);
      appendEvents(events, { maxRuntimeBytes });
      await expect(readEvents()).resolves.toEqual(events.slice(delta === 0 ? -2 : -1));
    },
  );

  it("loads a bounded trailing window in storage order", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "event-1" }),
      createTrajectoryEvent({ type: "event-2" }),
      createTrajectoryEvent({ type: "event-3" }),
    ]);

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      sessionId: "session-1",
      storePath,
      tailEvents: 2,
    });

    expect(rows.map((row) => row.event.type)).toEqual(["event-2", "event-3"]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("reads a missing trajectory store without creating an agent database", () => {
    const missingStorePath = path.join(tempDir, "agents", "missing", "sessions", "sessions.json");
    const missingDatabasePath = path.join(
      tempDir,
      "agents",
      "missing",
      "agent",
      "openclaw-agent.sqlite",
    );

    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        agentId: "missing",
        sessionId: "missing-session",
        storePath: missingStorePath,
      }),
    ).toEqual([]);
    expect(fs.existsSync(missingDatabasePath)).toBe(false);
  });

  it("applies maxEvents to a trailing window", () => {
    appendEvents([
      createTrajectoryEvent({ type: "event-1" }),
      createTrajectoryEvent({ type: "event-2" }),
      createTrajectoryEvent({ type: "event-3" }),
    ]);

    const rows = readRows({ tailEvents: 3, maxEvents: 1 });

    expect(rows.map((row) => row.event.type)).toEqual(["event-3"]);
  });

  it("cascades trajectory rows when the session row is deleted", async () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "model.started" }),
    ]);

    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    database.db.prepare("DELETE FROM session_windows WHERE session_id = ?").run("session-1");

    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([]);
  });
});

describe("SQLite trajectory runtime reader byte and count budgets", () => {
  useStore("agent:main:session-1");

  it("accepts a SQLite runtime event-count budget equal to the row count and rejects one over", () => {
    appendEvents([
      createTrajectoryEvent({ seq: 1, type: "boundary-row-1" }),
      createTrajectoryEvent({ seq: 2, type: "boundary-row-2" }),
    ]);

    expect(readRows({ maxEventCount: 2 }).length).toBe(2);
    expect(() => readRows({ maxEventCount: 1 })).toThrow(
      /runtime store has too many events to export/u,
    );
  });

  it("counts JSONL row separators in the runtime byte budget", () => {
    const events: TrajectoryEvent[] = [];
    const ROWS = 50;
    for (let i = 0; i < ROWS; i += 1) {
      events.push({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "sqlite-runtime",
        ts: "2026-04-01T05:46:41.000Z",
        seq: i + 1,
        sourceSeq: i + 1,
        sessionId: "session-1",
        data: { payload: "s" },
      });
    }
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [...events]);
    const rawSum = events.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"),
      0,
    );
    const jsonlSize = rawSum + ROWS - 1;
    expect(() =>
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventBytes: rawSum,
      }),
    ).toThrow(/runtime store is too large to export/u);
    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventBytes: jsonlSize,
      }).length,
    ).toBe(ROWS);
  });

  // OCTET_LENGTH measures the database encoding, so a UTF-16 store would otherwise
  // reject an ASCII transcript near half the documented UTF-8 cap and undercount
  // CJK-heavy text. Admission must measure the UTF-8 byte budget across encodings.
  it.each([
    { encoding: "UTF-8" as const, payload: "a".repeat(2000), label: "ascii" },
    { encoding: "UTF-16le" as const, payload: "a".repeat(2000), label: "ascii" },
    { encoding: "UTF-16be" as const, payload: "a".repeat(2000), label: "ascii" },
    { encoding: "UTF-8" as const, payload: "日本語🦞".repeat(400), label: "cjk" },
    { encoding: "UTF-16le" as const, payload: "日本語🦞".repeat(400), label: "cjk" },
    { encoding: "UTF-16be" as const, payload: "日本語🦞".repeat(400), label: "cjk" },
  ])(
    "measures the UTF-8 byte budget in $encoding for $label payloads",
    async ({ encoding, payload }) => {
      await seedEncoding(encoding);
      const events = ["alpha", "beta"].map((type) => {
        const event = createTrajectoryEvent({ type });
        event.data = { payload };
        return event;
      });
      appendEvents(events);
      const jsonlSize = eventBytes(events, -1);
      expect(readRows({ maxEventBytes: jsonlSize }).length).toBe(events.length);
      expect(() => readRows({ maxEventBytes: jsonlSize - 1 })).toThrow(
        /runtime store is too large to export/u,
      );
    },
  );
});

/** Inserts a competing oversized row via a second writable connection, called between the budget aggregate and payload SELECT. */
function createCompetingRowInjector(
  databasePath: string,
  sessionId: string,
): { inject: () => void; close: () => void } {
  const writerDb = openNodeSqliteDatabase(databasePath);
  const competingEvent = createTrajectoryEvent({ seq: 2, type: "competing-row", payloadSize: 256 });
  const competingJson = JSON.stringify(competingEvent);
  const insert = writerDb.prepare(
    "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  return {
    inject: () => insert.run(sessionId, 2, competingEvent.runId ?? null, competingJson, Date.now()),
    close: () => writerDb.close(),
  };
}

describe("SQLite trajectory runtime reader snapshot consistency", () => {
  useStore("agent:main:session-1");

  it("keeps the production reader's budget aggregate and payload SELECT in one deferred snapshot so a competing writer cannot cross the budget", () => {
    const event = createTrajectoryEvent({ seq: 1, type: "snapshot-row-1", payloadSize: 100 });
    appendEvents([event]);
    const rowBytes = Buffer.byteLength(JSON.stringify(event), "utf8");

    const database = openDatabase();
    const injector = createCompetingRowInjector(sqlitePath(), "session-1");
    const native = requireNativeSqliteDatabase(database.db);
    const prepare = native.prepare.bind(native);
    let injected = false;
    const prepareSpy = vi.spyOn(native, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      // Inject after the budget aggregate, before the payload SELECT iterates rows.
      if (!injected && sql.includes(`"seq", "event_json"`)) {
        injector.inject();
        injected = true;
      }
      return statement;
    });

    try {
      const rows = readRows({ maxEventBytes: rowBytes });

      expect(rows.map((row) => row.event.type)).toEqual(["snapshot-row-1"]);
      expect(injected).toBe(true);
    } finally {
      prepareSpy.mockRestore();
      injector.close();
    }
  });

  it("admits a within-budget two-row read at the exact byte boundary via the production reader", () => {
    const event = createTrajectoryEvent({ seq: 1, type: "admit-row-1", payloadSize: 100 });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [event]);
    const rowBytes = Buffer.byteLength(JSON.stringify(event), "utf8");

    const secondEvent = createTrajectoryEvent({
      seq: 2,
      type: "admit-row-2",
      payloadSize: 100,
    });
    const writerDb = openNodeSqliteDatabase(sqlitePath());
    writerDb
      .prepare(
        "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("session-1", 1, secondEvent.runId ?? null, JSON.stringify(secondEvent), Date.now());
    writerDb.close();

    const secondRowBytes = Buffer.byteLength(JSON.stringify(secondEvent), "utf8");
    const totalBudget = rowBytes + 1 + secondRowBytes; // 2 rows + 1 JSONL separator

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      sessionId: "session-1",
      storePath,
      maxEventBytes: totalBudget,
    });

    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.event.type)).toEqual(["admit-row-1", "admit-row-2"]);
  });
});
