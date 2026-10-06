// SQLite trajectory runtime tests cover session-scoped event row storage.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEventRowsSync,
  loadSqliteTrajectoryRuntimeEvents,
} from "./runtime-store.sqlite.js";
import { createTrajectoryEvent } from "./runtime-store.test-support.js";
import type { TrajectoryEvent } from "./types.js";

type TrajectoryRuntimeTestDatabase = Pick<OpenClawAgentKyselyDatabase, "trajectory_runtime_events">;

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-trajectory-sqlite-");

describe("SQLite trajectory runtime store", () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends batches in database order without trusting recorder-local seq", async () => {
    const events = Array.from({ length: 201 }, (_, index) =>
      createTrajectoryEvent({ seq: 1, type: `event-${index}` }),
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    Object.defineProperty(events[0], "toJSON", {
      value: () => {
        expect(database.db.isTransaction).toBe(false);
        return { ...events[0] };
      },
    });
    const counter = trackSqliteStatementExecutions(database.db, ["append"], (sql) =>
      /^insert into "trajectory_runtime_events"/i.test(sql) ? "append" : null,
    );
    try {
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, events);
      expect(counter.counts.append).toBeLessThan(10);
    } finally {
      counter.restore();
    }
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual(events);
    const db = getNodeSqliteKysely<TrajectoryRuntimeTestDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("trajectory_runtime_events")
        .select(["seq", "run_id"])
        .where("session_id", "=", "session-1")
        .orderBy("seq", "asc"),
    ).rows;
    expect(rows).toEqual(events.map((_, seq) => ({ run_id: "run-1", seq })));
  });

  it("rolls back a later batch failure and retries without losing or duplicating events", async () => {
    const scope = { sessionId: "session-1", storePath };
    const existing = createTrajectoryEvent({ type: "existing" });
    appendSqliteTrajectoryRuntimeEvents(scope, [existing]);
    const events = Array.from({ length: 100 }, (_, index) =>
      createTrajectoryEvent({ type: `pending-${index}` }),
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    database.db.exec(`CREATE TEMP TRIGGER reject_trajectory_append
      BEFORE INSERT ON trajectory_runtime_events WHEN NEW.seq = 65
      BEGIN SELECT RAISE(ABORT, 'synthetic later append failure'); END`);
    try {
      expect(() => appendSqliteTrajectoryRuntimeEvents(scope, events)).toThrow(
        "synthetic later append failure",
      );
      await expect(loadSqliteTrajectoryRuntimeEvents(scope)).resolves.toEqual([existing]);
    } finally {
      database.db.exec("DROP TRIGGER reject_trajectory_append");
    }
    appendSqliteTrajectoryRuntimeEvents(scope, events);
    expect(loadSqliteTrajectoryRuntimeEventRowsSync(scope)).toEqual(
      [existing, ...events].map((event, seq) => ({ event, seq })),
    );
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

  it("trims the retained byte window without fetching UTF-8 event bodies", async () => {
    const history = Array.from({ length: 64 }, (_, index) =>
      createTrajectoryEvent({ type: `old-${index}`, payloadSize: 64 * 1024 }),
    );
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, history);
    const newest = createTrajectoryEvent({ type: "newest" });
    const retained = [...history.slice(-2), newest];
    const maxRuntimeBytes = retained.reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
      0,
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    const prepare = database.db.prepare.bind(database.db);
    let materializedEvents = 0;
    const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
        for (const row of iterate(...args)) {
          if (typeof row.event_json === "string") {
            materializedEvents += 1;
          }
          yield row;
        }
        return undefined;
      });
      return statement;
    });
    try {
      appendSqliteTrajectoryRuntimeEvents({ maxRuntimeBytes, sessionId: "session-1", storePath }, [
        newest,
      ]);
      expect(materializedEvents).toBe(0);
    } finally {
      prepareSpy.mockRestore();
    }
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual(retained);
  });

  it.each(
    ["UTF-8", "UTF-16le", "UTF-16be"].flatMap((encoding) =>
      [0, -1].map((delta) => ({ encoding, delta })),
    ),
  )(
    "keeps the UTF-8 byte window in $encoding with a $delta-byte adjustment",
    async ({ encoding, delta }) => {
      if (encoding !== "UTF-8") {
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
      const events = ["old", "middle", "newest"].map((type) => {
        const event = createTrajectoryEvent({ type });
        event.data = { payload: "日本語🦞".repeat(20) };
        return event;
      });
      const maxRuntimeBytes = events
        .slice(-2)
        .reduce(
          (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
          delta,
        );
      appendSqliteTrajectoryRuntimeEvents(
        { maxRuntimeBytes, sessionId: "session-1", storePath },
        events,
      );
      await expect(
        loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
      ).resolves.toEqual(events.slice(delta === 0 ? -2 : -1));
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
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "event-1" }),
      createTrajectoryEvent({ type: "event-2" }),
      createTrajectoryEvent({ type: "event-3" }),
    ]);

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      sessionId: "session-1",
      storePath,
      tailEvents: 3,
      maxEvents: 1,
    });

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

  function sqlitePath(): string {
    return path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  }
});

describe("SQLite trajectory runtime reader byte and count budgets", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:session-1", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
  });

  it("accepts a SQLite runtime event-count budget equal to the row count and rejects one over", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ seq: 1, type: "boundary-row-1" }),
      createTrajectoryEvent({ seq: 2, type: "boundary-row-2" }),
    ]);

    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventCount: 2,
      }).length,
    ).toBe(2);
    expect(() =>
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventCount: 1,
      }),
    ).toThrow(/runtime store has too many events to export/u);
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
    { encoding: "UTF-8" as const, payload: "a".repeat(200), label: "ascii" },
    { encoding: "UTF-16le" as const, payload: "a".repeat(200), label: "ascii" },
    { encoding: "UTF-16be" as const, payload: "a".repeat(200), label: "ascii" },
    { encoding: "UTF-8" as const, payload: "日本語🦞".repeat(40), label: "cjk" },
    { encoding: "UTF-16le" as const, payload: "日本語🦞".repeat(40), label: "cjk" },
    { encoding: "UTF-16be" as const, payload: "日本語🦞".repeat(40), label: "cjk" },
  ])(
    "measures the UTF-8 byte budget in $encoding for $label payloads",
    async ({ encoding, payload }) => {
      if (encoding !== "UTF-8") {
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
      const events = ["alpha", "beta"].map((type) => {
        const event = createTrajectoryEvent({ type });
        event.data = { payload };
        return event;
      });
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, events);
      const jsonlSize = events.reduce(
        (total, event, index) =>
          total + Buffer.byteLength(JSON.stringify(event), "utf8") + (index > 0 ? 1 : 0),
        0,
      );
      // Budget equals the true UTF-8 size: admission must accept it in every encoding.
      expect(
        loadSqliteTrajectoryRuntimeEventRowsSync({
          sessionId: "session-1",
          storePath,
          maxEventBytes: jsonlSize,
        }).length,
      ).toBe(events.length);
      // One byte below the UTF-8 size must reject in every encoding.
      expect(() =>
        loadSqliteTrajectoryRuntimeEventRowsSync({
          sessionId: "session-1",
          storePath,
          maxEventBytes: jsonlSize - 1,
        }),
      ).toThrow(/runtime store is too large to export/u);
    },
  );
});

/** Inserts a competing oversized row via a second writable connection, called between the budget aggregate and payload SELECT. */
function createCompetingRowInjector(
  dbPath: string,
  sessionId: string,
): { inject: () => void; close: () => void } {
  const writerDb = openNodeSqliteDatabase(dbPath);
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
  let tempDir: string;
  let storePath: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:session-1", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
    dbPath = path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  });

  it("keeps the production reader's budget aggregate and payload SELECT in one deferred snapshot so a competing writer cannot cross the budget", () => {
    const event = createTrajectoryEvent({ seq: 1, type: "snapshot-row-1", payloadSize: 100 });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [event]);
    const rowBytes = Buffer.byteLength(JSON.stringify(event), "utf8");

    // Spy on the cached connection's prepare() to inject a competing row between the budget aggregate and payload SELECT.
    const database = openOpenClawAgentDatabase({ agentId: "main", path: dbPath });
    const injector = createCompetingRowInjector(dbPath, "session-1");
    const prepare = database.db.prepare.bind(database.db);
    let injected = false;
    const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      // Inject after the budget aggregate, before the payload SELECT iterates rows.
      if (!injected && sql.includes(`"seq", "event_json"`)) {
        injector.inject();
        injected = true;
      }
      return statement;
    });

    try {
      // The deferred transaction snapshot prevents the competing row from being visible.
      const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventBytes: rowBytes,
      });

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
    const writerDb = openNodeSqliteDatabase(dbPath);
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
