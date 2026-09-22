import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";
import {
  createUpdateRun,
  findActiveUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  getUpdateRunAsync,
  getUpdateRunStatusAsync,
  listUpdateRuns,
  listUpdateRunsAsync,
  recordUpdateRunPhase,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";

const tempDirs = createTempDirTracker();

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-ledger-") } };
}

function snapshotDatabaseFiles(filename: string) {
  const metadata = (pathname: string) => {
    const stat = fs.lstatSync(pathname, { bigint: true });
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  };
  const directory = path.dirname(filename);
  return {
    directory: metadata(directory),
    entries: fs.readdirSync(directory).toSorted(),
    files: ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const pathname = `${filename}${suffix}`;
      return fs.existsSync(pathname)
        ? {
            suffix,
            metadata: metadata(pathname),
            sha256: createHash("sha256").update(fs.readFileSync(pathname)).digest("hex"),
          }
        : { suffix, absent: true };
    }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("update run history reads", () => {
  it("keeps reads non-creating and adds the table on first write without changing the older schema", async () => {
    const options = isolatedOptions();
    const runId = randomUUID();
    const filename = resolveOpenClawStateSqlitePath(options.env);
    expect(getUpdateRun(runId, options)).toBeUndefined();
    expect(listUpdateRuns({}, options)).toEqual([]);
    expect(findActiveUpdateRun(options)).toBeUndefined();
    expect(await getUpdateRunAsync(runId, options)).toBeUndefined();
    expect(await listUpdateRunsAsync({}, options)).toEqual([]);
    expect(await getUpdateRunStatusAsync(options)).toEqual({});
    expect(fs.existsSync(filename)).toBe(false);
    expect(fs.readdirSync(options.env.OPENCLAW_STATE_DIR)).toEqual([]);

    const initial = openOpenClawStateDatabase(options);
    const hasLedger = () =>
      initial.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'update_runs'").get();
    expect(hasLedger()).toBeUndefined();
    const version = initial.db.prepare("PRAGMA user_version").get();
    const metadata = initial.db.prepare("SELECT * FROM schema_meta").all();
    const previousSchema = initial.db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY rowid",
      )
      .all()
      .map((row) => row.sql)
      .join(";\n");
    expect(listUpdateRuns({}, options)).toEqual([]);
    expect(hasLedger()).toBeUndefined();
    expect(() => recordUpdateRunPhase(runId, "staging", {}, options)).toThrow(
      "missing table update_runs",
    );
    expect(hasLedger()).toBeUndefined();

    const created = createUpdateRun({ runId, trigger: "cli" }, options);
    expect(created).toMatchObject({ runId, phase: "requested", status: "running" });
    closeOpenClawStateDatabaseForTest();
    const olderReader = new DatabaseSync(filename);
    try {
      assertSqliteSchemaContains(olderReader, filename, previousSchema);
      olderReader.prepare("UPDATE schema_meta SET updated_at = updated_at").run();
      expect(olderReader.prepare("PRAGMA user_version").get()).toEqual(version);
      expect(olderReader.prepare("SELECT * FROM schema_meta").all()).toEqual(metadata);
    } finally {
      olderReader.close();
    }
    expect(getUpdateRun(runId, options)).toEqual(created);
    expect(createUpdateRun({ runId, trigger: "api" }, options)).toEqual(created);
    expect(listUpdateRuns({}, options)).toEqual([created]);
  });

  it.each(
    (["get", "list", "active", "get-async", "list-async", "status"] as const).flatMap((reader) =>
      [false, true].map((retainedWal) => ({ reader, retainedWal })),
    ),
  )(
    "keeps cold $reader reads artifact-preserving with retained WAL=$retainedWal",
    async ({ reader, retainedWal }) => {
      const sourceOptions = isolatedOptions();
      const created = createUpdateRun({ trigger: "cli" }, sourceOptions);
      const sourcePath = resolveOpenClawStateSqlitePath(sourceOptions.env);
      let options = sourceOptions;
      let expected = created;
      if (retainedWal) {
        const { db } = openOpenClawStateDatabase(sourceOptions);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        expected = recordUpdateRunPhase(created.runId, "staging", {}, sourceOptions);
        options = isolatedOptions();
        const filename = resolveOpenClawStateSqlitePath(options.env);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        // Capture committed WAL bytes while the only producer is idle, then close
        // it before observing the copy. Omitting WAL must not return stale history.
        fs.copyFileSync(sourcePath, filename);
        fs.copyFileSync(`${sourcePath}-wal`, `${filename}-wal`);
        const mainOnly = path.join(tempDirs.make("openclaw-update-main-only-"), "main.sqlite");
        fs.copyFileSync(sourcePath, mainOnly);
        const control = new DatabaseSync(mainOnly, { readOnly: true });
        try {
          expect(
            control.prepare("SELECT phase FROM update_runs WHERE run_id = ?").get(created.runId),
          ).toEqual({ phase: "requested" });
        } finally {
          control.close();
        }
      }
      closeOpenClawStateDatabaseForTest();
      const filename = resolveOpenClawStateSqlitePath(options.env);
      expect(fs.existsSync(`${filename}-shm`)).toBe(false);
      expect(fs.existsSync(`${filename}-wal`)).toBe(retainedWal);
      const before = snapshotDatabaseFiles(filename);
      const nativeCalls = reader.endsWith("-async")
        ? [
            vi.spyOn(DatabaseSync.prototype, "prepare"),
            vi.spyOn(DatabaseSync.prototype, "exec"),
            ...(["get", "all", "run", "iterate"] as const).map((method) =>
              vi.spyOn(StatementSync.prototype, method),
            ),
          ]
        : [];
      const result =
        reader === "get"
          ? getUpdateRun(created.runId, options)
          : reader === "list"
            ? listUpdateRuns({}, options)
            : reader === "get-async"
              ? await getUpdateRunAsync(created.runId, options)
              : reader === "list-async"
                ? await listUpdateRunsAsync({}, options)
                : reader === "status"
                  ? await getUpdateRunStatusAsync(options)
                  : findActiveUpdateRun(options);
      expect(result).toEqual(
        reader === "status"
          ? { activeRun: expected, lastRun: expected }
          : reader === "list" || reader === "list-async"
            ? [expected]
            : expected,
      );
      expect(nativeCalls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(0);
      vi.restoreAllMocks();
      expect(snapshotDatabaseFiles(filename)).toEqual(before);
    },
  );

  it("reads rows persisted with the retired inferenceProbe verification fact", () => {
    const options = isolatedOptions();
    const run = createUpdateRun({ trigger: "cli" }, options);
    recordUpdateRunVerification(run.runId, { serviceRunning: true }, options);
    // Rows written before verification stopped recording inference keep the key;
    // the non-strict record schema drops it instead of rejecting the run.
    openOpenClawStateDatabase(options)
      .db.prepare("UPDATE update_runs SET verification_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ serviceRunning: true, inferenceProbe: "passed" }), run.runId);

    expect(getUpdateRun(run.runId, options)?.verification).toEqual({ serviceRunning: true });
  });

  it("leaves a cold store without the history table unchanged", async () => {
    const options = isolatedOptions();
    const { db } = openOpenClawStateDatabase(options);
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'update_runs'").get(),
    ).toBeUndefined();
    closeOpenClawStateDatabaseForTest();
    const filename = resolveOpenClawStateSqlitePath(options.env);
    const before = snapshotDatabaseFiles(filename);
    expect(getUpdateRun(randomUUID(), options)).toBeUndefined();
    expect(listUpdateRuns({}, options)).toEqual([]);
    expect(findActiveUpdateRun(options)).toBeUndefined();
    expect(await getUpdateRunAsync(randomUUID(), options)).toBeUndefined();
    expect(await listUpdateRunsAsync({}, options)).toEqual([]);
    expect(snapshotDatabaseFiles(filename)).toEqual(before);
  });

  it("keeps the idle cached writer usable after history reads", () => {
    const options = isolatedOptions();
    const created = createUpdateRun({ trigger: "cli" }, options);
    const { db } = openOpenClawStateDatabase(options);
    const filename = resolveOpenClawStateSqlitePath(options.env);
    const before = snapshotDatabaseFiles(filename);
    expect(getUpdateRun(created.runId, options)).toEqual(created);
    expect(listUpdateRuns({}, options)).toEqual([created]);
    expect(findActiveUpdateRun(options)).toEqual(created);
    expect(snapshotDatabaseFiles(filename)).toEqual(before);
    expect(db.isOpen).toBe(true);
    expect(recordUpdateRunPhase(created.runId, "staging", {}, options).phase).toBe("staging");
  });

  it("keeps asynchronous history reads on the inherited snapshot", async () => {
    const options = isolatedOptions();
    const created = createUpdateRun({ trigger: "cli" }, options);
    await withOpenClawStateDatabaseReadSnapshot(async () => {
      recordUpdateRunPhase(created.runId, "staging", {}, options);
      expect(await getUpdateRunAsync(created.runId, options)).toEqual(created);
      expect(await listUpdateRunsAsync({}, options)).toEqual([created]);
      expect(await getUpdateRunStatusAsync(options)).toEqual({
        activeRun: created,
        lastRun: created,
      });
    }, options);
    expect((await getUpdateRunAsync(created.runId, options))?.phase).toBe("staging");
  });

  it("reads committed history without consuming the cached writer's transaction", async () => {
    const options = isolatedOptions();
    const created = createUpdateRun({ trigger: "cli" }, options);
    const { db } = openOpenClawStateDatabase(options);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE update_runs SET phase = 'staging' WHERE run_id = ?").run(created.runId);
      expect(getUpdateRun(created.runId, options)).toEqual(created);
      expect(listUpdateRuns({}, options)).toEqual([created]);
      expect(findActiveUpdateRun(options)).toEqual(created);
      expect(await getUpdateRunStatusAsync(options)).toEqual({
        activeRun: created,
        lastRun: created,
      });
      expect(db.isTransaction).toBe(true);
      expect(
        db.prepare("SELECT phase FROM update_runs WHERE run_id = ?").get(created.runId),
      ).toEqual({
        phase: "staging",
      });
      db.exec("COMMIT");
    } finally {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
    }
    expect(getUpdateRun(created.runId, options)?.phase).toBe("staging");
  });

  it("lists newest runs deterministically and excludes terminal runs from active discovery", async () => {
    const options = isolatedOptions();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const oldest = createUpdateRun({ trigger: "cli" }, options);
    clock.mockReturnValue(2_000);
    const tied = [
      createUpdateRun({ trigger: "api" }, options),
      createUpdateRun({ trigger: "campaign" }, options),
    ].toSorted((left, right) => right.runId.localeCompare(left.runId));
    expect(listUpdateRuns({ limit: 2 }, options).map((run) => run.runId)).toEqual(
      tied.map((run) => run.runId),
    );
    expect((await listUpdateRunsAsync({ limit: 2 }, options)).map((run) => run.runId)).toEqual(
      tied.map((run) => run.runId),
    );
    expect(findActiveUpdateRun(options)).toEqual(tied[0]);
    for (const run of tied) {
      finishUpdateRun(run.runId, { status: "skipped", reason: "dry-run" }, options);
    }
    expect(listUpdateRuns({ active: true }, options)).toEqual([oldest]);
    expect(await listUpdateRunsAsync({ active: true }, options)).toEqual([oldest]);
    expect(
      (
        await listUpdateRunsAsync(
          { reason: "dry-run", limit: 1, includeRunId: oldest.runId },
          options,
        )
      ).map((run) => run.runId),
    ).toEqual([tied[0]?.runId, oldest.runId]);
    finishUpdateRun(oldest.runId, { status: "succeeded" }, options);
    expect(findActiveUpdateRun(options)).toBeUndefined();
    expect(listUpdateRuns({}, options)).toHaveLength(3);
  });
});
