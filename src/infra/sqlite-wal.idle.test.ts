import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { GatewayScheduler } from "./gateway-scheduler.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databases: ReturnType<typeof openNodeSqliteDatabase>[] = [];
const owners: ReturnType<typeof configureSqliteWalMaintenance>[] = [];
const counters: ReturnType<typeof trackSqliteStatementExecutions>[] = [];
const tick = { maxPages: 0, checkpointMode: "PASSIVE" as const };

function open(databasePath: string, readOnly = false) {
  const db = openNodeSqliteDatabase(databasePath, { readOnly });
  databases.push(db);
  return db;
}

function maintain(
  writer: ReturnType<typeof open>,
  options: Parameters<typeof configureSqliteWalMaintenance>[1],
) {
  const owner = configureSqliteWalMaintenance(writer, options);
  owners.push(owner);
  return owner;
}

function countCheckpoints(writer: ReturnType<typeof open>) {
  const counter = trackSqliteStatementExecutions(writer, ["checkpoint"], (sql) =>
    /wal_checkpoint/iu.test(sql) ? "checkpoint" : null,
  );
  counters.push(counter);
  return counter;
}

function fixture(options: Parameters<typeof configureSqliteWalMaintenance>[1] = {}) {
  const databasePath = path.join(tempDirs.make("openclaw-wal-idle-"), "state.sqlite");
  const writer = open(databasePath);
  const maintenance = maintain(writer, { databasePath, ...options });
  writer.exec("CREATE TABLE events(value TEXT)");
  return { databasePath, writer, maintenance, sibling: open(databasePath) };
}

describe("idle WAL checkpoint ticks", () => {
  afterEach(async () => {
    for (const counter of counters.splice(0)) {
      counter.restore();
    }
    for (const owner of owners.splice(0).toReversed()) {
      await owner.stop();
      owner.close();
    }
    for (const db of databases.splice(0).toReversed()) {
      db.close();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("disarms clean ticks and keeps the first sibling write deadline through later writes", async () => {
    const clock = createGatewaySchedulerClock(1_000);
    const scheduler = new GatewayScheduler({ clock: clock.clock });
    const originalScope = GatewayScheduler.prototype.scope.bind(scheduler);
    vi.spyOn(GatewayScheduler.prototype, "scope").mockImplementation(() => originalScope());
    const { writer, maintenance, sibling } = fixture();
    await clock.advanceBy(10_000);
    expect(maintenance.health?.state).toBe("complete");
    const periodicAtMs = 1_000 + 30 * 60_000;
    expect(clock.armedAtMs).toBe(periodicAtMs);
    await clock.advanceBy(10_000);
    expect(clock.armedAtMs).toBe(periodicAtMs);

    sibling.exec("BEGIN; INSERT INTO events VALUES ('first')");
    expect(clock.armedAtMs).toBe(periodicAtMs);
    sibling.exec("COMMIT");
    expect(clock.armedAtMs).toBe(31_000);
    await clock.advanceBy(5_000);
    sibling.exec("INSERT INTO events VALUES ('second')");
    expect(clock.armedAtMs).toBe(31_000);
    await clock.advanceBy(5_000);
    expect(maintenance.health?.state).toBe("complete");
    expect(clock.armedAtMs).toBe(periodicAtMs);

    await maintenance.stop();
    expect(clock.armedAtMs).toBeNull();
    sibling.exec("INSERT INTO events VALUES ('after-stop')");
    expect(clock.armedAtMs).toBeNull();
    expect(writer.prepare("SELECT value FROM events ORDER BY rowid").all()).toEqual([
      { value: "first" },
      { value: "second" },
      { value: "after-stop" },
    ]);
  });

  it("skips completed idle ticks and resumes after writes on either connection", async () => {
    vi.useFakeTimers();
    let admitted = true;
    const { writer, maintenance, sibling } = fixture({
      autoCheckpointPages: 0,
      runMaintenance: (operation) => admitted && operation(),
    });
    const statements = countCheckpoints(writer);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maintenance.health?.state).toBe("complete");
    expect(statements.counts.checkpoint).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statements.counts.checkpoint).toBe(1);

    sibling.exec("INSERT INTO events VALUES ('sibling')");
    admitted = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements.counts.checkpoint).toBe(1);
    admitted = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements.counts.checkpoint).toBe(2);
    expect(maintenance.health?.state).toBe("complete");
    writer.exec("INSERT INTO events VALUES ('owner')");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements.counts.checkpoint).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statements.counts.checkpoint).toBe(3);
    expect(sibling.prepare("SELECT value FROM events ORDER BY rowid").all()).toEqual([
      { value: "sibling" },
      { value: "owner" },
    ]);
  });

  it("retries a blocked checkpoint after its reader releases without another write", async () => {
    vi.useFakeTimers();
    const { writer, maintenance, sibling: reader } = fixture({ autoCheckpointPages: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    reader.exec("BEGIN");
    reader.prepare("SELECT value FROM events").all();
    writer.exec("INSERT INTO events VALUES ('retained')");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maintenance.health?.state).toBe("blocked");
    reader.exec("ROLLBACK");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maintenance.health?.state).toBe("complete");
    expect(maintenance.health?.checkpointedFrames).toBeGreaterThan(0);
  });

  it("shares completed frames across maintenance connections and invalidates them on sibling writes", () => {
    const options = { checkpointIntervalMs: 0, autoCheckpointPages: 0 };
    const { databasePath, writer, maintenance, sibling } = fixture(options);
    const siblingMaintenance = maintain(sibling, { databasePath, ...options });
    const statements = [writer, sibling].map(countCheckpoints);
    maintenance.maintainPeriodic?.(tick);
    siblingMaintenance.maintainPeriodic?.(tick);
    expect(statements.map(({ counts }) => counts.checkpoint)).toEqual([1, 0]);

    sibling.exec("INSERT INTO events VALUES ('sibling')");
    siblingMaintenance.maintainPeriodic?.(tick);
    maintenance.maintainPeriodic?.(tick);
    expect(statements.map(({ counts }) => counts.checkpoint)).toEqual([1, 1]);

    writer.exec("INSERT INTO events VALUES ('owner')");
    maintenance.maintainPeriodic?.(tick);
    siblingMaintenance.maintainPeriodic?.(tick);
    expect(statements.map(({ counts }) => counts.checkpoint)).toEqual([2, 1]);
    expect(sibling.prepare("SELECT value FROM events ORDER BY rowid").all()).toEqual([
      { value: "sibling" },
      { value: "owner" },
    ]);
  });

  it("stops retrying blocked frames after a sibling completes them without another write", () => {
    const options = { checkpointIntervalMs: 0, autoCheckpointPages: 0 };
    const { databasePath, writer, maintenance, sibling } = fixture(options);
    const siblingMaintenance = maintain(sibling, { databasePath, ...options });
    const reader = open(databasePath, true);
    const statements = countCheckpoints(writer);
    maintenance.maintainPeriodic?.(tick);
    reader.exec("BEGIN");
    reader.prepare("SELECT value FROM events").all();
    writer.exec("INSERT INTO events VALUES ('retained')");
    maintenance.maintainPeriodic?.(tick);
    siblingMaintenance.maintainPeriodic?.(tick);
    expect(maintenance.health?.state).toBe("blocked");
    expect(siblingMaintenance.health?.state).toBe("blocked");
    reader.exec("ROLLBACK");
    siblingMaintenance.maintainPeriodic?.(tick);
    expect(siblingMaintenance.health?.state).toBe("complete");
    expect(maintenance.maintainPeriodic?.(tick)?.checkpoint).toBeUndefined();
    expect(statements.counts.checkpoint).toBe(2);
  });

  it("keeps checkpointing untracked connections whose write revision is unknown", async () => {
    vi.useFakeTimers();
    const databasePath = path.join(tempDirs.make("openclaw-wal-untracked-"), "state.sqlite");
    const writer = new (requireNodeSqlite().DatabaseSync)(databasePath);
    databases.push(writer);
    maintain(writer, { databasePath });
    const statements = countCheckpoints(writer);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statements.counts.checkpoint).toBe(3);
  });
});
