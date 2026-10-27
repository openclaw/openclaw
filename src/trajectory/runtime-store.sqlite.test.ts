import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
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
  createTrajectoryEvent,
  trajectoryEventBytes as eventBytes,
} from "./runtime-store.test-support.js";
import type { TrajectoryEvent } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-trajectory-sqlite-");

let tempDir: string;
let storePath: string;

beforeEach(async () => {
  tempDir = sessionDirs.make();
  storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  await replaceSessionEntry(
    { sessionKey: "agent:main:main", storePath },
    { sessionId: "session-1", updatedAt: 10 },
  );
});

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

function serialized(event: TrajectoryEvent) {
  return { runId: event.runId, ts: event.ts, line: JSON.stringify(event) };
}

function eventsOf(...types: string[]) {
  return types.map((type) => createTrajectoryEvent({ type }));
}

function admitted<T>(operation: (owner: SqliteWorkerOperationContext) => T) {
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => grant());
  const owner: SqliteWorkerOperationContext = { port: admission.port };
  try {
    return { owner, window: withSqliteWorkerOperationAdmission(owner, () => operation(owner)) };
  } finally {
    admission.finish();
  }
}

function insertLegacyEvent(
  db: Pick<ReturnType<typeof openDatabase>["db"], "prepare">,
  event: TrajectoryEvent,
  seq: number,
) {
  db.prepare(
    "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(event.sessionId, seq, event.runId ?? null, JSON.stringify(event), Date.parse(event.ts));
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
    const append = () => admitted(() => operations["trajectory.events.append"](input, context));
    return { database, context, input, append, operations, event };
  }

  it("publishes the append receipt and uses its next window", async () => {
    const { input, append, event } = await workerAppend();
    const first = append();
    expect(first.owner.committed).toEqual({
      facts: {
        kind: "trajectory-runtime-append",
        sessionId: "session-1",
        windowFacts: first.window,
      },
    });
    input.windowFacts = first.window;
    expect(append().owner.committed).toMatchObject({ facts: { windowFacts: { nextSeq: 2 } } });
    expect(readRows()).toEqual([
      { seq: 0, event },
      { seq: 1, event },
    ]);
  });

  it("refuses receipt capture and final admission before attempting the terminal INSERT", async () => {
    const { context, input, append, operations } = await workerAppend();
    expect(() => operations["trajectory.events.append"](input, context)).toThrow(/receipt/i);
    context.admit = () => {
      throw new Error("append revoked");
    };
    expect(append).toThrow("append revoked");
    expect(readRows()).toEqual([]);
  });

  it.each(["statement", "lock"])(
    "keeps a failed %s unpublished and permits a later append",
    async (failure) => {
      const { database, context, input, operations, append, event } = await workerAppend(0);
      const blocker = openNodeSqliteDatabase(sqlitePath());
      if (failure === "lock") {
        blocker.exec("BEGIN IMMEDIATE");
      } else {
        database.db
          .exec(`CREATE TEMP TRIGGER reject_terminal_append BEFORE INSERT ON trajectory_runtime_events
        BEGIN SELECT RAISE(ABORT, 'terminal insert rejected'); END`);
      }
      try {
        admitted((owner) => {
          expect(() => operations["trajectory.events.append"](input, context)).toThrow(
            failure === "lock" ? /locked|busy/i : "terminal insert rejected",
          );
          expect(owner.committed).toBeUndefined();
        });
      } finally {
        if (failure === "lock") {
          blocker.exec("ROLLBACK");
        } else {
          database.db.exec("DROP TRIGGER reject_terminal_append");
        }
        blocker.close();
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
      try {
        expect(append).toThrow("append revoked");
      } finally {
        Atomics.store(lease, 0, 0);
      }
      expect(readRows()).toEqual([]);
    },
  );

  it("reads mixed payloads with byte limits, cursors and commit rollback", async () => {
    const { database, context, operations } = await workerAppend();
    const events = ["legacy", "first", "second", "third"].map((type) =>
      createTrajectoryEvent({ type, payloadSize: 4096 }),
    );
    insertLegacyEvent(database.db, events[0]!, 0);
    let rejectCommit = false;
    context.admit = (stage) => {
      if (rejectCommit && stage === "commit") {
        throw new Error("synthetic commit rejection");
      }
    };
    const append = (batch: TrajectoryEvent[], maxRuntimeBytes?: number) => {
      return admitted(() =>
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
      ).window;
    };
    append(events.slice(1, 3));
    await expect(readEvents()).resolves.toEqual(events.slice(0, 3));
    const maxEventBytes = eventBytes(events.slice(0, 3), -1);
    expect(readRows({ maxEventBytes })).toHaveLength(3);
    expect(readRows({ maxEventCount: 3 })).toHaveLength(3);
    expect(() => readRows({ maxEventBytes: maxEventBytes - 1 })).toThrow(/too large to export/);
    expect(() => readRows({ maxEventCount: 2 })).toThrow(/too many events/);
    expect(readRows({ afterSeq: 0, maxEvents: 1 })).toEqual([{ seq: 1, event: events[1] }]);
    expect(readRows({ tailEvents: 1 })).toEqual([{ seq: 2, event: events[2] }]);
    expect(readRows({ tailEvents: 2 })).toEqual([
      { seq: 1, event: events[1] },
      { seq: 2, event: events[2] },
    ]);
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

  it("trims, empties and replaces a window without invalidating transcript receipts", async () => {
    await replaceSessionEntry(
      { sessionKey: "agent:main:other", storePath },
      { sessionId: "session-2", updatedAt: 10 },
    );
    const database = openDatabase();
    const scopes = [
      "agent:main:main",
      "agent:main:other",
      sqliteSessionIdWriteScope("session-1"),
      sqliteSessionIdWriteScope("session-2"),
    ];
    const token = readSqliteDatabaseScopedWriteToken(database.db, scopes);
    expect(token).toBeTypeOf("string");
    const events = eventsOf("first🦞", "later🦞", "final🦞");
    const maxRuntimeBytes = eventBytes(events.slice(0, 2));
    const append = (
      event: TrajectoryEvent,
      windowFacts?: { nextSeq: number; retainedBytes: number },
      discardPrevious = false,
    ) =>
      appendSqliteTrajectoryRuntimeEventsWithWriter(
        {
          sessionId: "session-1",
          maxRuntimeBytes,
          windowFacts,
          discardPrevious,
          events: [serialized(event)],
        },
        database,
        (operationLabel, write) =>
          runOpenClawAgentWriteTransaction(
            write,
            { agentId: "main", path: sqlitePath() },
            { operationLabel },
          ),
      ).receipt.windowFacts;
    const first = append(events[0]!);
    const second = append(events[1]!, first);
    expect(second).toEqual({ nextSeq: 2, retainedBytes: maxRuntimeBytes });
    const committed = append(events[2]!, second);
    expect(committed).toEqual({ nextSeq: 3, retainedBytes: maxRuntimeBytes });
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
    expect(append(events[1]!, undefined, true)).toEqual({
      nextSeq: 2,
      retainedBytes: eventBytes([events[1]!]),
    });
    expect(readRows()).toEqual([{ event: events[1], seq: 1 }]);
    expect(readSqliteDatabaseScopedWriteToken(database.db, scopes)).toBe(token);
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

  it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
    "reads only the expired prefix when a full %s window advances",
    async (encoding) => {
      await seedEncoding(encoding);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: encoding === "UTF-8" ? sqlitePath() : storePath,
      });
      const event = createTrajectoryEvent({ type: "rolling-window🦞" });
      const bytes = eventBytes([event]);
      const append = (
        events: TrajectoryEvent[],
        windowFacts?: { nextSeq: number; retainedBytes: number },
      ) =>
        appendSqliteTrajectoryRuntimeEventsWithWriter(
          {
            sessionId: "session-1",
            maxRuntimeBytes: bytes * 128,
            events: events.map(serialized),
            windowFacts,
          },
          database,
          (operationLabel, write) =>
            runOpenClawAgentWriteTransaction(
              write,
              { agentId: "main", path: database.path },
              { operationLabel },
            ),
        ).receipt.windowFacts;
      const initial = append(Array.from({ length: 128 }, () => event));
      const native = requireNativeSqliteDatabase(database.db);
      const prepare = native.prepare.bind(native);
      let visited = 0;
      const spy = vi.spyOn(native, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (sql.includes('from "trajectory_runtime_events"')) {
          const iterate = statement.iterate.bind(statement);
          statement.iterate = function* (...parameters) {
            for (const row of iterate(...parameters)) {
              visited++;
              yield row;
            }
          };
        }
        return statement;
      });
      try {
        expect(append([event], initial)).toEqual({ nextSeq: 129, retainedBytes: bytes * 128 });
      } finally {
        spy.mockRestore();
      }
      expect(readRows()).toEqual(
        Array.from({ length: 128 }, (_, index) => ({ event, seq: index + 1 })),
      );
      expect(visited).toBe(1);
    },
  );

  it.each(["0", "1969-12-31T23:59:59.000Z"])(
    "stores Date.parse-compatible trajectory timestamp %s",
    (timestamp) => {
      appendEvents([createTrajectoryEvent({ ts: timestamp, type: "timestamp-contract" })]);

      const rows = openDatabase()
        .db.prepare("SELECT created_at FROM trajectory_runtime_events WHERE session_id = ?")
        .all("session-1");
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
    await expect(readEvents()).resolves.toEqual([]);
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

  it("reads a missing trajectory store without creating an agent database", () => {
    const missing = path.join(tempDir, "agents/missing");
    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        agentId: "missing",
        sessionId: "missing-session",
        storePath: path.join(missing, "sessions/sessions.json"),
      }),
    ).toEqual([]);
    expect(fs.existsSync(path.join(missing, "agent/openclaw-agent.sqlite"))).toBe(false);
  });

  it("cascades trajectory rows when the session row is deleted", async () => {
    appendEvents(eventsOf("model.started"));
    const database = openDatabase();
    database.db.prepare("DELETE FROM session_windows WHERE session_id = ?").run("session-1");
    await expect(readEvents()).resolves.toEqual([]);
  });
});

describe("SQLite trajectory runtime reader byte and count budgets", () => {
  // OCTET_LENGTH measures the database encoding, so a UTF-16 store would otherwise
  // reject an ASCII transcript near half the documented UTF-8 cap and undercount
  // CJK-heavy text. Admission must measure the UTF-8 byte budget across encodings.
  it.each(
    ["UTF-8", "UTF-16le", "UTF-16be"].flatMap((encoding) => [
      { encoding, payload: "a".repeat(2000), label: "ascii" },
      { encoding, payload: "日本語🦞".repeat(400), label: "cjk" },
    ]),
  )(
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

describe("SQLite trajectory runtime reader snapshot consistency", () => {
  it("keeps budget admission and payload reads in one snapshot", () => {
    const event = createTrajectoryEvent({ seq: 1, type: "snapshot-row-1", payloadSize: 100 });
    appendEvents([event]);
    const rowBytes = Buffer.byteLength(JSON.stringify(event), "utf8");

    const database = openDatabase();
    const writerDb = openNodeSqliteDatabase(sqlitePath());
    const competingEvent = createTrajectoryEvent({
      seq: 2,
      type: "competing-row",
      payloadSize: 256,
    });
    const native = requireNativeSqliteDatabase(database.db);
    const prepare = native.prepare.bind(native);
    let injected = false;
    const prepareSpy = vi.spyOn(native, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      // Inject after the budget aggregate, before the payload SELECT iterates rows.
      if (!injected && sql.includes(`"seq", "event_json"`)) {
        insertLegacyEvent(writerDb, competingEvent, 2);
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
      writerDb.close();
    }
  });
});
