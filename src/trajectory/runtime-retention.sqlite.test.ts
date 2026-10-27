import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  readSqliteDatabaseScopedWriteToken,
  sqliteSessionIdWriteScope,
} from "../infra/sqlite-database-admission.js";
import { retainAgentDatabase } from "../state/openclaw-agent-db-borrower.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { createAgentWorkerTestLoaders } from "../state/openclaw-agent-execution-operations.test-support.js";
import type { AgentWorkerOperationContext } from "../state/openclaw-agent-operation-context.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  beginTrajectoryRuntimeRetention,
  prepareTrajectoryRuntimeRetention,
} from "./runtime-retention.sqlite.js";
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

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-trajectory-retention-sqlite-");

let tempDir: string;
let storePath: string;
const now = Date.parse("2026-07-26T00:00:00.000Z");
beforeEach(async () => {
  tempDir = sessionDirs.make();
  storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  await replaceSessionEntry(
    { sessionKey: "agent:main:main", storePath },
    { sessionId: "session-1", updatedAt: 10 },
  );
});
afterEach(() => vi.useRealTimers());

function currentEvent(
  type: string,
  options: Omit<Parameters<typeof createTrajectoryEvent>[0], "type"> = {},
) {
  return createTrajectoryEvent({ type, ts: new Date(Date.now()).toISOString(), ...options });
}

function append(sessionId: string, events: TrajectoryEvent[], maxGlobalRuntimeBytes?: number) {
  appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath, maxGlobalRuntimeBytes }, events);
}

function startCurrent(payloadSize?: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const current = currentEvent("current", { payloadSize });
  append("session-1", [current]);
  return current;
}

function nextWindow(...retained: TrajectoryEvent[]) {
  vi.advanceTimersByTime(60 * 60 * 1000);
  const trigger = currentEvent("trigger");
  return { trigger, maxGlobalRuntimeBytes: eventBytes([...retained, trigger]) };
}

async function addHistory(
  types: string[],
  timestamp = (index: number) => now - 1000 + index,
  payloadSize = 2048,
) {
  await addSession("history");
  const events = types.map((type, index) =>
    currentEvent(type, {
      sessionId: "history",
      runId: type,
      payloadSize,
      ts: new Date(timestamp(index)).toISOString(),
    }),
  );
  append("history", events);
  return events;
}

function appendManaged(event: TrajectoryEvent, discardPrevious = false) {
  const options = { agentId: "main", path: sqlitePath() };
  appendSqliteTrajectoryRuntimeEventsWithWriter(
    {
      sessionId: event.sessionId,
      discardPrevious,
      events: [{ runId: event.runId, ts: event.ts, line: JSON.stringify(event) }],
    },
    openOpenClawAgentDatabase(options),
    (operationLabel, write) => runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
  );
}

it.each(["missing", "invalidated", "empty"] as const)(
  "admits a retention write only for a current selection (%s)",
  async (mode) => {
    const options = { agentId: "main", path: sqlitePath() };
    const database = openOpenClawAgentDatabase(options);
    const lease = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(lease, 0, 1);
    const sweepId =
      mode === "missing" ? "missing" : beginTrajectoryRuntimeRetention(database.db, lease);
    const snapshot =
      mode === "missing"
        ? undefined
        : prepareTrajectoryRuntimeRetention(database.db, { sessionId: "session-1" }, Date.now());
    if (mode === "invalidated") {
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "session_nodes">>(database.db)
          .updateTable("session_nodes")
          .set({ updated_at: 11 })
          .where("session_key", "=", "agent:main:main"),
      );
    }
    const context: AgentWorkerOperationContext = {
      options,
      open: () => database,
      admit() {},
      writeTransaction: (operationLabel, _owner, write) =>
        runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
    };
    const operations = await createAgentWorkerTestLoaders(context)["trajectory.retention.delete"]();
    using observe = vi.spyOn(database.db, "exec");
    try {
      expect(
        operations["trajectory.retention.delete"]({ sweepId, snapshot }, context),
      ).toMatchObject({
        complete: mode === "empty",
        refresh: mode !== "empty",
        deleted: 0,
      });
      expect(observe.mock.calls.filter(([sql]) => sql === "BEGIN IMMEDIATE")).toHaveLength(
        mode === "empty" ? 1 : 0,
      );
    } finally {
      Atomics.store(lease, 0, 0);
    }
  },
);

it("rejects only changed runs while draining an eviction plan under competing writes", async () => {
  startCurrent();
  await addSession("history");
  append("history", [
    createTrajectoryEvent({ sessionId: "history", type: "old" }),
    createTrajectoryEvent({ sessionId: "history", runId: "unchanged", type: "evict" }),
  ]);
  vi.advanceTimersByTime(60 * 60 * 1_000);
  withCompetingSelectionWrite(
    (competing) =>
      competing
        .prepare(
          "UPDATE trajectory_runtime_events SET created_at = ? WHERE session_id = ? AND run_id = 'run-1'",
        )
        .run(Date.now(), "history"),
    () => append("session-1", [currentEvent("trigger")]),
  );
  await expectTypes({ history: ["old"] });
});

it.each(["sibling", "managed"])(
  "preserves recent runs when a %s trim removes global budget pressure",
  async (writer) => {
    const current = startCurrent(4096);
    await addSession("history");
    append("history", [currentEvent("recent", { sessionId: "history" })]);
    const { trigger, maxGlobalRuntimeBytes } = nextWindow(current);
    withCompetingSelectionWrite(
      (competing) => {
        if (writer === "sibling") {
          competing.exec(
            "DELETE FROM trajectory_runtime_events WHERE session_id = 'session-1' AND seq = 0",
          );
        } else {
          appendManaged(trigger, true);
        }
      },
      () => append("session-1", [trigger], maxGlobalRuntimeBytes),
      1,
      writer === "managed",
    );
    await expectTypes({ history: ["recent"], "session-1": ["trigger"] });
  },
);

it.each(["trimmed", "expired", "recent"] as const)(
  "reselects older history after a competing %s mutation",
  async (mutation) => {
    const current = startCurrent();
    const expiredAt = now - 15 * 24 * 60 * 60 * 1000;
    const history = await addHistory(
      mutation === "trimmed" ? ["older", "older", "newer"] : ["older", "newer"],
      (index) => (mutation === "expired" && index === 0 ? expiredAt : now - 1000 + index),
    );
    const { trigger, maxGlobalRuntimeBytes } = nextWindow(
      current,
      expectDefined(history.at(-1), "newer history event"),
    );
    const arrival = createTrajectoryEvent({
      sessionId: "history",
      runId: "arrival",
      type: "arrival",
      payloadSize: 4096,
      ts: new Date(mutation === "expired" ? expiredAt : now - 2000).toISOString(),
    });
    withCompetingSelectionWrite(
      (competing) => {
        if (mutation === "trimmed") {
          competing.exec(
            "DELETE FROM trajectory_runtime_events WHERE session_id = 'history' AND seq = 0",
          );
          return;
        }
        if (mutation === "recent") {
          competing.exec(
            "DELETE FROM trajectory_runtime_events WHERE session_id = 'history' AND seq = 1",
          );
        }
        competing
          .prepare(`INSERT INTO trajectory_runtime_events
            (session_id, seq, run_id, event_json, created_at) VALUES ('history', 2, 'arrival', ?, ?)`)
          .run(JSON.stringify(arrival), Date.parse(arrival.ts));
      },
      () => append("session-1", [trigger], maxGlobalRuntimeBytes),
    );
    await expectTypes({ history: [mutation === "recent" ? "older" : "newer"] });
  },
);

it("settles a budget sweep without waiting for a write-free reader pass", async () => {
  const current = startCurrent();
  const history = await addHistory(["A", "B", "C"], () => now - 1000, 120);
  const { trigger, maxGlobalRuntimeBytes } = nextWindow(current, ...history.slice(0, 2));
  let arrivals = 0;
  withCompetingSelectionWrite(
    () => {
      const type = String.fromCharCode("D".charCodeAt(0) + arrivals);
      const arrival = currentEvent(type, { sessionId: "history", runId: type });
      arrivals++;
      appendManaged(arrival);
    },
    () => append("session-1", [trigger], maxGlobalRuntimeBytes),
    // Let a regressed sweep finish once the competing writer goes quiet.
    4,
    true,
  );
  await expectTypes({ history: ["C", "D"], "session-1": ["current", "trigger"] });
});

it.each(["budget", "age"] as const)(
  "rechecks an empty selection after competing %s growth",
  async (reason) => {
    const current = startCurrent();
    const history = await addHistory(["older", "newer"]);
    const { trigger, maxGlobalRuntimeBytes: initialBytes } = nextWindow(current, ...history);
    const growth = currentEvent("growth", { payloadSize: 1024 });
    const maxGlobalRuntimeBytes = reason === "budget" ? initialBytes : initialBytes * 2;
    const growthSession = reason === "budget" ? "session-1" : "history";
    const growthTime = reason === "budget" ? Date.now() : now - 15 * 24 * 60 * 60 * 1000;
    withCompetingSelectionWrite(
      (competing) =>
        competing
          .prepare(`INSERT INTO trajectory_runtime_events
        (session_id, seq, run_id, event_json, created_at) VALUES (?, 2, 'growth', ?, ?)`)
          .run(growthSession, JSON.stringify(growth), growthTime),
      () => append("session-1", [trigger], maxGlobalRuntimeBytes),
    );
    await expectTypes({
      history: reason === "budget" ? ["newer"] : ["older", "newer"],
      "session-1": reason === "budget" ? ["current", "trigger", "growth"] : ["current", "trigger"],
    });
  },
);

it("keeps the committed append when retention fails and retries retention on the next append", async () => {
  startCurrent();
  await addSession("history");
  append("history", [createTrajectoryEvent({ sessionId: "history", type: "old" })]);
  const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
  using _ = { [Symbol.dispose]: retainAgentDatabase(database.db) };
  database.db.exec(`CREATE TEMP TRIGGER reject_retention
      BEFORE DELETE ON trajectory_runtime_events WHEN OLD.session_id = 'history'
      BEGIN SELECT RAISE(ABORT, 'synthetic retention failure'); END`);
  vi.advanceTimersByTime(60 * 60 * 1_000);
  try {
    append("session-1", [currentEvent("retention-failed")]);
    await expectTypes({ "session-1": ["current", "retention-failed"], history: ["old"] });
  } finally {
    database.db.exec("DROP TRIGGER reject_retention");
  }
  append("session-1", [currentEvent("retry-retention")]);
  await expectTypes({
    history: [],
    "session-1": ["current", "retention-failed", "retry-retention"],
  });
});

it.each(
  ["UTF-8", "UTF-16le", "UTF-16be"].flatMap((encoding) =>
    [0, -1].map((delta) => ({ encoding, delta })),
  ),
)(
  "evicts complete runs at the global native-byte budget in $encoding ($delta-byte adjustment)",
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
    const nativeEncoding = encoding === "UTF-8" ? "utf8" : "utf16le";
    const eventBytesInEncoding = (events: TrajectoryEvent[]) =>
      events.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), nativeEncoding) + 1,
        0,
      );
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const initial = [createTrajectoryEvent({ payloadSize: 200, type: "current-initial" })];
    append("session-1", initial);
    const bytesBefore = new Map([["session-1", eventBytesInEncoding(initial)]]);
    for (const [index, sessionId] of ["oldest", "middle", "newest"].entries()) {
      await addSession(sessionId);
      const events = [0, 1].map((part) => {
        const event = createTrajectoryEvent({
          sessionId,
          type: `${sessionId}-${part}`,
          ts: new Date(now - (3 - index) * 24 * 60 * 60 * 1_000 + part).toISOString(),
        });
        event.runId =
          sessionId === "middle" || (sessionId === "oldest" && part === 0)
            ? undefined
            : "shared-run";
        event.data = { payload: "日本語🦞".repeat(100) };
        return event;
      });
      append(sessionId, events);
      bytesBefore.set(sessionId, eventBytesInEncoding(events));
    }
    const trigger = currentEvent("current-newest", {
      payloadSize: 200,
      ts: new Date(now + 60 * 60 * 1_000).toISOString(),
    });
    const triggerBytes = Buffer.byteLength(JSON.stringify(trigger), nativeEncoding) + 1;
    const totalBytes = [...bytesBefore.values()].reduce((total, bytes) => total + bytes, 0);
    const evictedBytes = (bytesBefore.get("oldest") ?? 0) + (bytesBefore.get("middle") ?? 0);
    const maxGlobalRuntimeBytes = totalBytes + triggerBytes - evictedBytes + delta;

    withGlobalSelection(() => {
      vi.advanceTimersByTime(60 * 60 * 1_000);
      append("session-1", [trigger], maxGlobalRuntimeBytes);
    });

    await expectTypes({
      oldest: [],
      middle: [],
      newest: delta === 0 ? ["newest-0", "newest-1"] : [],
      "session-1": ["current-initial", "current-newest"],
    });
  },
);

it("drains complete runs through byte-bounded transactions despite writes between batches", async () => {
  startCurrent();
  for (let index = 0; index < 12; index++) {
    const sessionId = `history-${String(index).padStart(2, "0")}`;
    await addSession(sessionId);
    const historical = createTrajectoryEvent({
      sessionId,
      type: "part",
      payloadSize: 256 * 1024 - 512,
      ts: new Date(now - 15 * 86_400_000 + index * 1_000).toISOString(),
    });
    append(
      sessionId,
      Array.from({ length: 4 }, () => historical),
    );
  }
  const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
  using _ = { [Symbol.dispose]: retainAgentDatabase(database.db) };
  using competing = openNodeSqliteDatabase(sqlitePath());
  const retainedRuns = () =>
    database.db
      .prepare(`SELECT session_id, count(*) AS rows
      FROM trajectory_runtime_events WHERE session_id != 'session-1'
      GROUP BY session_id ORDER BY session_id`)
      .all();
  const retainedAfterDeletes: ReturnType<typeof retainedRuns>[] = [];
  let previousRows = 48;
  const exec = database.db.exec.bind(database.db);
  const commits = vi.spyOn(database.db, "exec").mockImplementation((statement) => {
    exec(statement);
    if (statement === "COMMIT") {
      const remaining = retainedRuns();
      const rows = remaining.reduce((count, run) => count + Number(run.rows), 0);
      if (rows < previousRows) {
        retainedAfterDeletes.push(remaining);
        const event = currentEvent(`pressure-${retainedAfterDeletes.length}`);
        competing
          .prepare(`INSERT INTO trajectory_runtime_events
            (session_id, seq, run_id, event_json, created_at)
            SELECT 'session-1', max(seq) + 1, 'run-1', ?, ?
            FROM trajectory_runtime_events WHERE session_id = 'session-1'`)
          .run(JSON.stringify(event), Date.now());
      }
      previousRows = rows;
    }
  });
  vi.advanceTimersByTime(60 * 60 * 1_000);
  try {
    append("session-1", [currentEvent("sweep")]);
  } finally {
    commits.mockRestore();
  }
  const tail = ["history-10", "history-11"].map((session_id) => ({ session_id, rows: 4 }));
  expect(retainedAfterDeletes).toEqual([tail, []]);
  await expectTypes({ "session-1": ["current", "sweep", "pressure-1", "pressure-2"] });
});

it.each([
  ["a", "Z"],
  ["a\uFE0F", "a\u{E0100}"],
])("preserves locale/BINARY order and null-first ties (%s, %s)", async (older, newer) => {
  const current = startCurrent();
  const runs: TrajectoryEvent[] = [];
  for (const sessionId of [newer, older]) {
    await addSession(sessionId);
    const events = [undefined, ""].map((runId) => {
      const event = createTrajectoryEvent({
        sessionId,
        type: runId === undefined ? "null-run" : "empty-run",
        ts: new Date(now - 86_400_000).toISOString(),
      });
      event.runId = runId;
      return event;
    });
    runs.push(...events);
    append(sessionId, events);
  }
  const retained = runs.find((event) => event.sessionId === newer && event.runId === "")!;
  const { trigger, maxGlobalRuntimeBytes } = nextWindow(current, retained);
  append("session-1", [trigger], maxGlobalRuntimeBytes);
  await expectTypes({ [older]: [], [newer]: ["empty-run"] });
});

it("retains the same newest runs when eviction spans several selection pages", async () => {
  const current = startCurrent();
  await addSession("history");
  const payload = JSON.stringify({ type: "historical" });
  runOpenClawAgentWriteTransaction(
    ({ db }) => {
      const insert = db.prepare(`INSERT INTO trajectory_runtime_events
        (session_id, seq, run_id, event_json, created_at) VALUES ('history', ?, ?, ?, ?)`);
      for (let index = 0; index < 200; index++) {
        // Reverse time order forces selection to replace earlier candidates.
        insert.run(index, `run-${String(index).padStart(5, "0")}`, payload, now - index - 1);
      }
    },
    { agentId: "main", path: sqlitePath() },
  );
  const { trigger, maxGlobalRuntimeBytes } = nextWindow(current);
  append("session-1", [trigger], maxGlobalRuntimeBytes + 3 * (Buffer.byteLength(payload) + 1));
  expect(
    loadSqliteTrajectoryRuntimeEventRowsSync({ sessionId: "history", storePath }).map(
      (row) => row.seq,
    ),
  ).toEqual([0, 1, 2]);
});

it("rate-limits the global sweep instead of running it on every insert", async () => {
  startCurrent();
  await addSession("old-session");
  const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
  const scopes = [sqliteSessionIdWriteScope("session-1"), sqliteSessionIdWriteScope("old-session")];
  using _ = { [Symbol.dispose]: retainAgentDatabase(database.db) };
  const token = readSqliteDatabaseScopedWriteToken(database.db, scopes);
  expect(token).toBeTypeOf("string");
  append("old-session", [
    createTrajectoryEvent({
      sessionId: "old-session",
      type: "old",
      ts: new Date(now - 15 * 24 * 60 * 60 * 1_000).toISOString(),
    }),
  ]);
  append("session-1", [createTrajectoryEvent({ type: "same-window" })]);
  await expectTypes({ "old-session": ["old"] });
  expect(readSqliteDatabaseScopedWriteToken(database.db, scopes)).toBe(token);

  vi.advanceTimersByTime(60 * 60 * 1_000);
  expect(() =>
    runOpenClawAgentWriteTransaction(
      () => {
        append("session-1", [currentEvent("rolled-back")]);
        throw new Error("synthetic enclosing rollback");
      },
      { agentId: "main", path: sqlitePath() },
    ),
  ).toThrow("synthetic enclosing rollback");
  await expectTypes({ "old-session": ["old"] });
  append("session-1", [currentEvent("next-window")]);
  await expectTypes({ "old-session": [] });
  expect(readSqliteDatabaseScopedWriteToken(database.db, scopes)).toBe(token);
});

function withCompetingSelectionWrite(
  mutate: (db: DatabaseSync) => void,
  runAppend: () => void,
  maxWrites = 1,
  managed = false,
) {
  using competing = openNodeSqliteDatabase(sqlitePath());
  competing.exec("PRAGMA busy_timeout = 0");
  let writes = 0;
  withGlobalSelection(runAppend, (native) => {
    if (writes < maxWrites) {
      writes++;
      mutate(managed ? native : competing);
    }
  });
}

function withGlobalSelection(run: () => void, afterSelection?: (native: DatabaseSync) => void) {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
  using _ = { [Symbol.dispose]: retainAgentDatabase(database.db) };
  const native = requireNativeSqliteDatabase(database.db);
  clearNodeSqliteKyselyCacheForDatabase(native);
  const prepare = native.prepare.bind(native);
  let selections = 0;
  let writing = false;
  const exec = database.db.exec.bind(database.db);
  const transactionSpy = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
    exec(sql);
    if (sql.startsWith("BEGIN")) {
      writing = sql === "BEGIN IMMEDIATE";
    } else if (sql === "COMMIT" || sql === "ROLLBACK") {
      writing = false;
    }
  });
  const spy = vi.spyOn(native, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (
      sql.includes('"trajectory_runtime_events"') &&
      (afterSelection ? /group by/i.test(sql) : sql.includes("sum(")) &&
      !/where/i.test(sql)
    ) {
      const selected = (args: Parameters<typeof statement.all>) => {
        selections++;
        if (afterSelection) {
          afterSelection(native);
        } else {
          expect(writing, "global aggregation must not hold the writer lock").toBe(false);
          const details = prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...args)
            .map((row) => row.detail);
          expect(details).toContainEqual(
            expect.stringContaining(
              "SCAN trajectory_runtime_events USING COVERING INDEX idx_agent_trajectory_runtime_run",
            ),
          );
          expect(details).not.toContainEqual(expect.stringMatching(/USE TEMP B-TREE FOR GROUP BY/));
        }
      };
      const all = statement.all.bind(statement);
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        const rows = all(...args);
        selected(args);
        return rows;
      });
      vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
        yield* iterate(...args);
        selected(args);
        return undefined;
      });
    }
    return statement;
  });
  try {
    run();
    expect(selections).toBeGreaterThan(0);
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(native);
    spy.mockRestore();
    transactionSpy.mockRestore();
  }
}

function sqlitePath(): string {
  return storePath.endsWith(".sqlite")
    ? storePath
    : path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
}

async function addSession(sessionId: string): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: `agent:main:${sessionId}`, storePath },
    { sessionId, updatedAt: Date.now() },
  );
}

async function expectTypes(expected: Record<string, string[]>) {
  for (const [sessionId, types] of Object.entries(expected)) {
    const events = await loadSqliteTrajectoryRuntimeEvents({ sessionId, storePath });
    expect(
      events.map((event) => event.type),
      sessionId,
    ).toEqual(types);
  }
}
