import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  appendSqliteTrajectoryRuntimeEventsWithWriter,
  loadSqliteTrajectoryRuntimeEventRowsSync,
  loadSqliteTrajectoryRuntimeEvents,
} from "./runtime-store.sqlite.js";
import { createTrajectoryEvent } from "./runtime-store.test-support.js";
import type { TrajectoryEvent } from "./types.js";

type TrajectoryRuntimeTestDatabase = Pick<OpenClawAgentKyselyDatabase, "trajectory_runtime_events">;
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-trajectory-retention-sqlite-");

describe("SQLite trajectory runtime retention", () => {
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

  it("drops old runs while retaining recent runs", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() }),
    ]);
    await addSession("history");
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, [
      createTrajectoryEvent({
        runId: "old-run",
        sessionId: "history",
        type: "old",
        ts: new Date(now - 15 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
      createTrajectoryEvent({
        runId: "recent-run",
        sessionId: "history",
        type: "recent",
        ts: new Date(now - 13 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
    ]);

    vi.advanceTimersByTime(60 * 60 * 1_000);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "sweep-trigger", ts: new Date(Date.now()).toISOString() }),
    ]);

    await expect(runtimeEventTypes("history")).resolves.toEqual(["recent"]);
  });

  it("rejects only changed runs while draining an eviction plan under competing writes", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() }),
    ]);
    await addSession("history");
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, [
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
      () =>
        appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
          createTrajectoryEvent({ type: "trigger", ts: new Date(Date.now()).toISOString() }),
        ]),
    );
    await expect(runtimeEventTypes("history")).resolves.toEqual(["old"]);
  });

  it.each(["foreign", "managed"])(
    "preserves recent runs when a %s trim removes global budget pressure",
    async (writer) => {
      const now = Date.parse("2026-07-26T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const current = createTrajectoryEvent({
        type: "current",
        payloadSize: 4096,
        ts: new Date(now).toISOString(),
      });
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [current]);
      await addSession("history");
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, [
        createTrajectoryEvent({
          sessionId: "history",
          type: "recent",
          ts: new Date(now).toISOString(),
        }),
      ]);
      vi.advanceTimersByTime(60 * 60 * 1_000);
      const trigger = createTrajectoryEvent({
        type: "trigger",
        ts: new Date(Date.now()).toISOString(),
      });
      const maxGlobalRuntimeBytes = [current, trigger].reduce(
        (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      );
      withCompetingSelectionWrite(
        (competing) => {
          if (writer === "foreign") {
            competing.exec(
              "DELETE FROM trajectory_runtime_events WHERE session_id = 'session-1' AND seq = 0",
            );
          } else {
            appendSqliteTrajectoryRuntimeEventsWithWriter(
              { sessionId: "session-1", events: [trigger], discardPrevious: true },
              (operationLabel, write) =>
                runOpenClawAgentWriteTransaction(
                  write,
                  { agentId: "main", path: sqlitePath() },
                  { operationLabel },
                ),
            );
          }
        },
        () =>
          appendSqliteTrajectoryRuntimeEvents(
            { sessionId: "session-1", storePath, maxGlobalRuntimeBytes },
            [trigger],
          ),
        1,
        writer === "managed",
      );
      await expect(runtimeEventTypes("history")).resolves.toEqual(["recent"]);
      await expect(runtimeEventTypes("session-1")).resolves.toEqual(["trigger"]);
    },
  );

  it("reselects a trimmed older run before evicting newer budget-only history", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const current = createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [current]);
    await addSession("history");
    const history = ["older", "older", "newer"].map((runId, index) =>
      createTrajectoryEvent({
        sessionId: "history",
        runId,
        type: runId,
        payloadSize: 2048,
        ts: new Date(now - 1000 + index).toISOString(),
      }),
    );
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, history);
    vi.advanceTimersByTime(60 * 60 * 1000);
    const trigger = createTrajectoryEvent({
      type: "trigger",
      ts: new Date(Date.now()).toISOString(),
    });
    const maxGlobalRuntimeBytes = [current, history[2], trigger].reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
      0,
    );
    withCompetingSelectionWrite(
      (competing) =>
        competing.exec(
          "DELETE FROM trajectory_runtime_events WHERE session_id = 'history' AND seq = 0",
        ),
      () =>
        appendSqliteTrajectoryRuntimeEvents(
          { sessionId: "session-1", storePath, maxGlobalRuntimeBytes },
          [trigger],
        ),
    );
    await expect(runtimeEventTypes("history")).resolves.toEqual(["newer"]);
  });

  it.each(["expired", "recent"] as const)(
    "reselects older %s arrivals before evicting newer history",
    async (age) => {
      const now = Date.parse("2026-07-26T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const current = createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() });
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [current]);
      await addSession("history");
      const expiredAt = now - 15 * 24 * 60 * 60 * 1000;
      const history = ["older", "newer"].map((type, index) =>
        createTrajectoryEvent({
          sessionId: "history",
          runId: type,
          type,
          payloadSize: 2048,
          ts: new Date(
            age === "expired" && index === 0 ? expiredAt : now - 1000 + index,
          ).toISOString(),
        }),
      );
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, history);
      vi.advanceTimersByTime(60 * 60 * 1000);
      const trigger = createTrajectoryEvent({
        type: "trigger",
        ts: new Date(Date.now()).toISOString(),
      });
      const maxGlobalRuntimeBytes = [current, history[1], trigger].reduce(
        (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      );
      const arrival = createTrajectoryEvent({
        sessionId: "history",
        runId: "arrival",
        type: "arrival",
        payloadSize: 4096,
        ts: new Date(age === "expired" ? expiredAt : now - 2000).toISOString(),
      });
      withCompetingSelectionWrite(
        (competing) => {
          if (age === "recent") {
            competing.exec(
              "DELETE FROM trajectory_runtime_events WHERE session_id = 'history' AND seq = 1",
            );
          }
          competing
            .prepare(`INSERT INTO trajectory_runtime_events
            (session_id, seq, run_id, event_json, created_at) VALUES ('history', 2, 'arrival', ?, ?)`)
            .run(JSON.stringify(arrival), Date.parse(arrival.ts));
        },
        () =>
          appendSqliteTrajectoryRuntimeEvents(
            { sessionId: "session-1", storePath, maxGlobalRuntimeBytes },
            [trigger],
          ),
      );
      await expect(runtimeEventTypes("history")).resolves.toEqual([
        age === "expired" ? "newer" : "older",
      ]);
    },
  );

  it("settles a budget sweep without waiting for a write-free reader pass", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const current = createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [current]);
    await addSession("history");
    const history = ["A", "B", "C"].map((type) =>
      createTrajectoryEvent({
        sessionId: "history",
        runId: type,
        type,
        ts: new Date(now - 1000).toISOString(),
      }),
    );
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, history);
    vi.advanceTimersByTime(60 * 60 * 1000);
    const trigger = createTrajectoryEvent({
      type: "trigger",
      ts: new Date(Date.now()).toISOString(),
    });
    const maxGlobalRuntimeBytes = [current, trigger, ...history.slice(0, 2)].reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
      0,
    );
    let arrivals = 0;
    withCompetingSelectionWrite(
      () => {
        const type = String.fromCharCode("D".charCodeAt(0) + arrivals);
        const event = createTrajectoryEvent({
          sessionId: "history",
          runId: type,
          type,
          ts: new Date(Date.now()).toISOString(),
        });
        arrivals++;
        appendSqliteTrajectoryRuntimeEventsWithWriter(
          { sessionId: "history", events: [event] },
          (operationLabel, write) =>
            runOpenClawAgentWriteTransaction(
              write,
              { agentId: "main", path: sqlitePath() },
              { operationLabel },
            ),
        );
      },
      () =>
        appendSqliteTrajectoryRuntimeEvents(
          { sessionId: "session-1", storePath, maxGlobalRuntimeBytes },
          [trigger],
        ),
      // Let a regressed sweep finish once the competing writer goes quiet.
      4,
      true,
    );
    await expect(runtimeEventTypes("history")).resolves.toEqual(["C", "D"]);
    await expect(runtimeEventTypes("session-1")).resolves.toEqual(["current", "trigger"]);
  });

  it.each(["budget", "age"] as const)(
    "rechecks an empty selection after competing %s growth",
    async (reason) => {
      const now = Date.parse("2026-07-26T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const current = createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() });
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [current]);
      await addSession("history");
      const history = ["older", "newer"].map((type, index) =>
        createTrajectoryEvent({
          sessionId: "history",
          runId: type,
          type,
          payloadSize: 2048,
          ts: new Date(now - 1000 + index).toISOString(),
        }),
      );
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, history);
      vi.advanceTimersByTime(60 * 60 * 1000);
      const trigger = createTrajectoryEvent({
        type: "trigger",
        ts: new Date(Date.now()).toISOString(),
      });
      const initialBytes = [current, ...history, trigger].reduce(
        (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      );
      const growth = createTrajectoryEvent({
        type: "growth",
        payloadSize: 1024,
        ts: new Date(Date.now()).toISOString(),
      });
      const maxGlobalRuntimeBytes = reason === "budget" ? initialBytes : initialBytes * 2;
      const growthSession = reason === "budget" ? "session-1" : "history";
      const growthTime = reason === "budget" ? Date.now() : now - 15 * 24 * 60 * 60 * 1000;
      withCompetingSelectionWrite(
        (competing) =>
          competing
            .prepare(`INSERT INTO trajectory_runtime_events
        (session_id, seq, run_id, event_json, created_at) VALUES (?, 2, 'growth', ?, ?)`)
            .run(growthSession, JSON.stringify(growth), growthTime),
        () =>
          appendSqliteTrajectoryRuntimeEvents(
            { sessionId: "session-1", storePath, maxGlobalRuntimeBytes },
            [trigger],
          ),
      );
      await expect(runtimeEventTypes("history")).resolves.toEqual(
        reason === "budget" ? ["newer"] : ["older", "newer"],
      );
      await expect(runtimeEventTypes("session-1")).resolves.toEqual(
        reason === "budget" ? ["current", "trigger", "growth"] : ["current", "trigger"],
      );
    },
  );

  it("keeps the committed append when retention fails and retries retention on the next append", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() }),
    ]);
    await addSession("history");
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, [
      createTrajectoryEvent({ sessionId: "history", type: "old" }),
    ]);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    database.db.exec(`CREATE TEMP TRIGGER reject_retention
      BEFORE DELETE ON trajectory_runtime_events WHEN OLD.session_id = 'history'
      BEGIN SELECT RAISE(ABORT, 'synthetic retention failure'); END`);
    vi.advanceTimersByTime(60 * 60 * 1_000);
    try {
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
        createTrajectoryEvent({ type: "retention-failed", ts: new Date(Date.now()).toISOString() }),
      ]);
      await expect(runtimeEventTypes("session-1")).resolves.toEqual([
        "current",
        "retention-failed",
      ]);
      await expect(runtimeEventTypes("history")).resolves.toEqual(["old"]);
    } finally {
      database.db.exec("DROP TRIGGER reject_retention");
    }
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "retry-retention", ts: new Date(Date.now()).toISOString() }),
    ]);
    await expect(runtimeEventTypes("history")).resolves.toEqual([]);
    await expect(runtimeEventTypes("session-1")).resolves.toEqual([
      "current",
      "retention-failed",
      "retry-retention",
    ]);
  });

  it.each([0, -1])(
    "evicts complete runs at the global UTF-8 byte budget (%i-byte adjustment)",
    async (delta) => {
      const now = Date.parse("2026-07-26T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
        createTrajectoryEvent({ payloadSize: 200, type: "current-initial" }),
      ]);
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
          event.data = { payload: "日本語🦞".repeat(40) };
          return event;
        });
        appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath }, events);
      }
      const bytesBefore = runtimeBytesBySession();
      const trigger = createTrajectoryEvent({
        payloadSize: 200,
        type: "current-newest",
        ts: new Date(now + 60 * 60 * 1_000).toISOString(),
      });
      const triggerBytes = Buffer.byteLength(JSON.stringify(trigger), "utf8") + 1;
      const maxGlobalRuntimeBytes =
        [...bytesBefore.values()].reduce((total, bytes) => total + bytes, 0) +
        triggerBytes -
        (bytesBefore.get("oldest") ?? 0) -
        (bytesBefore.get("middle") ?? 0) +
        delta;

      const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
      clearNodeSqliteKyselyCacheForDatabase(database.db);
      const prepare = database.db.prepare.bind(database.db);
      let aggregates = 0;
      let writing = false;
      const nativeExec = database.db.exec.bind(database.db);
      const transactionSpy = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
        nativeExec(sql);
        if (sql.startsWith("BEGIN")) {
          writing = sql === "BEGIN IMMEDIATE";
        } else if (sql === "COMMIT" || sql === "ROLLBACK") {
          writing = false;
        }
      });
      const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (
          sql.includes('"trajectory_runtime_events"') &&
          sql.includes("sum(") &&
          !/where/i.test(sql)
        ) {
          const all = statement.all.bind(statement);
          const get = statement.get.bind(statement);
          const iterate = statement.iterate.bind(statement);
          const assertAggregatePlan = (
            rows: ReturnType<typeof statement.all>,
            args: Parameters<typeof statement.all>,
          ) => {
            aggregates += 1;
            expect(writing, "global aggregation must not hold the writer lock").toBe(false);
            const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
            const details = plan.map((row) => row.detail);
            expect(
              details.filter(
                (detail) =>
                  typeof detail === "string" &&
                  /(?:SCAN|SEARCH) trajectory_runtime_events\b/.test(detail),
              ),
            ).toEqual([
              expect.stringMatching(
                /SCAN trajectory_runtime_events USING COVERING INDEX idx_agent_trajectory_runtime_run/,
              ),
            ]);
            expect(details).not.toContainEqual(
              expect.stringMatching(/USE TEMP B-TREE FOR GROUP BY/),
            );
            return rows;
          };
          vi.spyOn(statement, "all").mockImplementation((...args) =>
            assertAggregatePlan(all(...args), args),
          );
          vi.spyOn(statement, "get").mockImplementation((...args) => {
            const row = get(...args);
            assertAggregatePlan(row ? [row] : [], args);
            return row;
          });
          vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
            yield* assertAggregatePlan([...iterate(...args)], args);
            return undefined;
          });
        }
        return statement;
      });
      try {
        vi.advanceTimersByTime(60 * 60 * 1_000);
        appendSqliteTrajectoryRuntimeEvents(
          { maxGlobalRuntimeBytes, sessionId: "session-1", storePath },
          [trigger],
        );
        expect(aggregates).toBeGreaterThan(0);
      } finally {
        clearNodeSqliteKyselyCacheForDatabase(database.db);
        prepareSpy.mockRestore();
        transactionSpy.mockRestore();
      }

      await expect(runtimeEventTypes("oldest")).resolves.toEqual([]);
      await expect(runtimeEventTypes("middle")).resolves.toEqual([]);
      await expect(runtimeEventTypes("newest")).resolves.toEqual(
        delta === 0 ? ["newest-0", "newest-1"] : [],
      );
      await expect(runtimeEventTypes("session-1")).resolves.toEqual([
        "current-initial",
        "current-newest",
      ]);
    },
  );

  it("drains complete runs through byte-bounded transactions despite writes between batches", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() }),
    ]);
    for (let index = 0; index < 12; index++) {
      const sessionId = `history-${String(index).padStart(2, "0")}`;
      await addSession(sessionId);
      appendSqliteTrajectoryRuntimeEvents(
        { sessionId, storePath },
        Array.from({ length: 4 }, (_, part) =>
          createTrajectoryEvent({
            sessionId,
            type: `part-${part}`,
            payloadSize: 256 * 1024 - 512,
            ts: new Date(now - 15 * 86_400_000 + index * 1_000).toISOString(),
          }),
        ),
      );
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    const competing = openNodeSqliteDatabase(sqlitePath());
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
          const event = createTrajectoryEvent({
            type: `pressure-${retainedAfterDeletes.length}`,
            ts: new Date(Date.now()).toISOString(),
          });
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
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
        createTrajectoryEvent({ type: "sweep", ts: new Date(Date.now()).toISOString() }),
      ]);
    } finally {
      commits.mockRestore();
      competing.close();
    }
    expect(retainedAfterDeletes).toEqual([
      [
        { session_id: "history-10", rows: 4 },
        { session_id: "history-11", rows: 4 },
      ],
      [],
    ]);
    await expect(runtimeEventTypes("session-1")).resolves.toEqual([
      "current",
      "sweep",
      "pressure-1",
      "pressure-2",
    ]);
  });

  it.each([
    ["a", "Z"],
    ["a\uFE0F", "a\u{E0100}"],
  ])("preserves locale/BINARY order and null-first ties (%s, %s)", async (older, newer) => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const current = createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [current]);
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
      appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath }, events);
    }
    vi.advanceTimersByTime(60 * 60 * 1_000);
    const trigger = createTrajectoryEvent({
      type: "trigger",
      ts: new Date(Date.now()).toISOString(),
    });
    const retained = runs.find((event) => event.sessionId === newer && event.runId === "")!;
    const maxGlobalRuntimeBytes = [current, trigger, retained].reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
      0,
    );
    appendSqliteTrajectoryRuntimeEvents(
      { sessionId: "session-1", storePath, maxGlobalRuntimeBytes },
      [trigger],
    );
    await expect(runtimeEventTypes(older)).resolves.toEqual([]);
    await expect(runtimeEventTypes(newer)).resolves.toEqual(["empty-run"]);
  });

  it("retains the same newest runs when eviction spans several selection pages", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const current = createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [current]);
    await addSession("history");
    const count = 200;
    const payload = JSON.stringify({ type: "historical" });
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        const insert = db.prepare(`INSERT INTO trajectory_runtime_events
        (session_id, seq, run_id, event_json, created_at) VALUES ('history', ?, ?, ?, ?)`);
        for (let index = 0; index < count; index++) {
          // Reverse time order forces selection to replace earlier candidates.
          insert.run(index, `run-${String(index).padStart(5, "0")}`, payload, now - index - 1);
        }
      },
      { agentId: "main", path: sqlitePath() },
    );
    vi.advanceTimersByTime(60 * 60 * 1_000);
    const trigger = createTrajectoryEvent({
      type: "trigger",
      ts: new Date(Date.now()).toISOString(),
    });
    const currentBytes = [current, trigger].reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1,
      0,
    );
    appendSqliteTrajectoryRuntimeEvents(
      {
        sessionId: "session-1",
        storePath,
        maxGlobalRuntimeBytes: currentBytes + 3 * (Buffer.byteLength(payload) + 1),
      },
      [trigger],
    );
    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({ sessionId: "history", storePath }).map(
        (row) => row.seq,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("rate-limits the global sweep instead of running it on every insert", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "current" }),
    ]);
    await addSession("old-session");
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "old-session", storePath }, [
      createTrajectoryEvent({
        sessionId: "old-session",
        type: "old",
        ts: new Date(now - 15 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
    ]);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "same-window" }),
    ]);
    await expect(runtimeEventTypes("old-session")).resolves.toEqual(["old"]);

    vi.advanceTimersByTime(60 * 60 * 1_000);
    expect(() =>
      runOpenClawAgentWriteTransaction(
        () => {
          appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
            createTrajectoryEvent({ type: "rolled-back", ts: new Date(Date.now()).toISOString() }),
          ]);
          throw new Error("synthetic enclosing rollback");
        },
        { agentId: "main", path: sqlitePath() },
      ),
    ).toThrow("synthetic enclosing rollback");
    await expect(runtimeEventTypes("old-session")).resolves.toEqual(["old"]);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "next-window", ts: new Date(Date.now()).toISOString() }),
    ]);
    await expect(runtimeEventTypes("old-session")).resolves.toEqual([]);
  });

  function withCompetingSelectionWrite(
    mutate: (db: DatabaseSync) => void,
    append: () => void,
    maxWrites = 1,
    managed = false,
  ) {
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    const competing = openNodeSqliteDatabase(sqlitePath());
    competing.exec("PRAGMA busy_timeout = 0");
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    const prepare = database.db.prepare.bind(database.db);
    const exec = database.db.exec.bind(database.db);
    let selectionPrepared = false;
    let writes = 0;
    let reading = false;
    const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
      selectionPrepared ||=
        query.includes('"trajectory_runtime_events"') && /group by/i.test(query);
      return prepare(query);
    });
    const commit = vi.spyOn(database.db, "exec").mockImplementation((statement) => {
      if (statement.startsWith("BEGIN")) {
        reading = statement === "BEGIN";
      }
      const inject = statement === "COMMIT" && reading && selectionPrepared && writes < maxWrites;
      if (inject && !managed) {
        mutate(competing);
        writes++;
      }
      exec(statement);
      if (statement === "COMMIT" || statement === "ROLLBACK") {
        reading = false;
      }
      // Managed receipts publish through the real append owner after the read releases its snapshot.
      if (inject && managed) {
        writes++;
        mutate(database.db);
      }
    });
    try {
      append();
      expect(writes).toBeGreaterThan(0);
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(database.db);
      commit.mockRestore();
      spy.mockRestore();
      competing.close();
    }
  }

  function sqlitePath(): string {
    return path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  }

  async function addSession(sessionId: string): Promise<void> {
    await replaceSessionEntry(
      { sessionKey: `agent:main:${sessionId}`, storePath },
      { sessionId, updatedAt: Date.now() },
    );
  }

  async function runtimeEventTypes(sessionId: string): Promise<string[]> {
    const events = await loadSqliteTrajectoryRuntimeEvents({ sessionId, storePath });
    return events.map((event) => event.type);
  }

  function runtimeBytesBySession(): Map<string, number> {
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    const db = getNodeSqliteKysely<TrajectoryRuntimeTestDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("trajectory_runtime_events").select(["session_id", "event_json"]),
    ).rows;
    const bytesBySession = new Map<string, number>();
    for (const row of rows) {
      bytesBySession.set(
        row.session_id,
        (bytesBySession.get(row.session_id) ?? 0) + Buffer.byteLength(row.event_json, "utf8") + 1,
      );
    }
    return bytesBySession;
  }
});
