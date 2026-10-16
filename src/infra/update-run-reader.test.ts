import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withOpenClawStateDatabaseReadSnapshot as withSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as closeStateAsync,
  closeOpenClawStateDatabaseForTest as closeState,
  openOpenClawStateDatabase as openState,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as statePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.test-support.js";
import {
  createUpdateRun as createRun,
  findActiveUpdateRun as findActive,
  finishUpdateRun as finishRun,
  getUpdateRun as getRun,
  getUpdateRunAsync as getRunAsync,
  getUpdateRunStatusAsync as getStatus,
  listUpdateRuns as listRuns,
  listUpdateRunsAsync as listRunsAsync,
  recordUpdateRunPhase as recordPhase,
  recordUpdateRunVerification as recordVerification,
} from "./update-run-ledger.js";

const tempDirs = createTempDirTracker();
type Options = ReturnType<typeof isolatedOptions>;
type Run = ReturnType<typeof createRun>;

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-ledger-") } };
}
function setupRun() {
  const options = isolatedOptions();
  const created = createRun({ trigger: "cli" }, options);
  return { options, created, db: openState(options).db, filename: statePath(options.env) };
}

function readers(runId: string, options: Options, run?: Run) {
  const list = run ? [run] : [];
  return {
    get: [() => getRun(runId, options), run],
    list: [() => listRuns({}, options), list],
    active: [() => findActive(options), run],
    "get-async": [() => getRunAsync(runId, options), run],
    "list-async": [() => listRunsAsync({}, options), list],
    status: [() => getStatus(options), run ? { activeRun: run, lastRun: run } : {}],
  } as const;
}

function expectReads(cases: ReturnType<typeof readers>) {
  for (const [read, expected] of [cases.get, cases.list, cases.active]) {
    expect(read()).toEqual(expected);
  }
}
async function expectAsyncReads(cases: ReturnType<typeof readers>) {
  for (const [read, expected] of [cases["get-async"], cases["list-async"], cases.status]) {
    expect(await read()).toEqual(expected);
  }
}

function snapshot(filename: string) {
  const metadata = (pathname: string) => {
    const s = fs.lstatSync(pathname, { bigint: true });
    return [s.dev, s.ino, s.mode, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs];
  };
  const directory = path.dirname(filename);
  return {
    directory: metadata(directory),
    entries: fs.readdirSync(directory).toSorted(),
    files: ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const pathname = `${filename}${suffix}`;
      if (!fs.existsSync(pathname)) {
        return { suffix, absent: true };
      }
      const sha256 = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
      return { suffix, metadata: metadata(pathname), sha256 };
    }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeStateAsync();
  closeState();
  tempDirs.cleanup();
});

it("creates the ledger only on write, preserving older schema", async () => {
  const options = isolatedOptions();
  const runId = randomUUID();
  const filename = statePath(options.env);
  expectReads(readers(runId, options));
  await expectAsyncReads(readers(runId, options));
  expect(fs.existsSync(filename)).toBe(false);
  expect(fs.readdirSync(options.env.OPENCLAW_STATE_DIR)).toEqual([]);

  openState(options);
  closeState();
  const before = snapshot(filename);
  expectReads(readers(runId, options));
  await expectAsyncReads(readers(runId, options));
  expect(snapshot(filename)).toEqual(before);

  const { db } = openState(options);
  const hasLedger = () =>
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'update_runs'").get();
  expect(hasLedger()).toBeUndefined();
  const version = db.prepare("PRAGMA user_version").get();
  const metadata = db.prepare("SELECT * FROM schema_meta").all();
  const previousSchema = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY rowid",
    )
    .all()
    .map((row) => row.sql)
    .join(";\n");
  expect(listRuns({}, options)).toEqual([]);
  expect(hasLedger()).toBeUndefined();
  expect(() => recordPhase(runId, "staging", {}, options)).toThrow("missing table update_runs");
  expect(hasLedger()).toBeUndefined();

  const created = createRun({ runId, trigger: "cli" }, options);
  expect(created).toMatchObject({ runId, phase: "requested", status: "running" });
  closeState();
  {
    using olderReader = new DatabaseSync(filename);
    assertSqliteSchemaContains(olderReader, filename, previousSchema);
    olderReader.prepare("UPDATE schema_meta SET updated_at = updated_at").run();
    expect(olderReader.prepare("PRAGMA user_version").get()).toEqual(version);
    expect(olderReader.prepare("SELECT * FROM schema_meta").all()).toEqual(metadata);
  }
  expect(getRun(runId, options)).toEqual(created);
  expect(createRun({ runId, trigger: "api" }, options)).toEqual(created);
  expect(listRuns({}, options)).toEqual([created]);
});

it.each([
  ...(["get", "list", "active", "get-async", "list-async", "status"] as const).map((reader) => ({
    reader,
    retainedWal: true,
  })),
  { reader: "get", retainedWal: false },
  { reader: "get-async", retainedWal: false },
])("preserves cold artifacts ($reader/WAL=$retainedWal)", async ({ reader, retainedWal }) => {
  const { options: sourceOptions, created, filename: sourcePath } = setupRun();
  let options = sourceOptions;
  let expected = created;
  if (retainedWal) {
    const { db } = openState(sourceOptions);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expected = recordPhase(created.runId, "staging", {}, sourceOptions);
    options = isolatedOptions();
    const filename = statePath(options.env);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    // Capture committed WAL bytes while the only producer is idle, then close
    // it before observing the copy. Omitting WAL must not return stale history.
    fs.copyFileSync(sourcePath, filename);
    fs.copyFileSync(`${sourcePath}-wal`, `${filename}-wal`);
    const mainOnly = path.join(tempDirs.make("openclaw-update-main-only-"), "main.sqlite");
    fs.copyFileSync(sourcePath, mainOnly);
    using control = new DatabaseSync(mainOnly, { readOnly: true });
    expect(
      control.prepare("SELECT phase FROM update_runs WHERE run_id = ?").get(created.runId),
    ).toEqual({ phase: "requested" });
  }
  closeState();
  const filename = statePath(options.env);
  expect(fs.existsSync(`${filename}-shm`)).toBe(false);
  expect(fs.existsSync(`${filename}-wal`)).toBe(retainedWal);
  const before = snapshot(filename);
  const nativeCalls =
    reader.endsWith("-async") || reader === "status" ? observeMainThreadSql() : undefined;
  const [read, expectedResult] = readers(created.runId, options, expected)[reader];
  expect(nativeCalls ? await read() : read()).toEqual(expectedResult);
  expect(nativeCalls?.count() ?? 0).toBe(0);
  vi.restoreAllMocks();
  expect(snapshot(filename)).toEqual(before);
});

it("reads retired inferenceProbe verification facts", () => {
  const { options, created: run, db } = setupRun();
  recordVerification(run.runId, { serviceRunning: true }, options);
  // Rows written before verification stopped recording inference keep the key;
  // the non-strict record schema drops it instead of rejecting the run.
  db.prepare("UPDATE update_runs SET verification_json = ? WHERE run_id = ?").run(
    JSON.stringify({ serviceRunning: true, inferenceProbe: "passed" }),
    run.runId,
  );

  expect(getRun(run.runId, options)?.verification).toEqual({ serviceRunning: true });
});

it("keeps idle writer usable after history reads", () => {
  const { options, created, db, filename } = setupRun();
  const before = snapshot(filename);
  expectReads(readers(created.runId, options, created));
  expect(snapshot(filename)).toEqual(before);
  expect(db.isOpen).toBe(true);
  expect(recordPhase(created.runId, "staging", {}, options).phase).toBe("staging");
});

it("async reads inherit the snapshot", async () => {
  const { options, created } = setupRun();
  await withSnapshot(async () => {
    recordPhase(created.runId, "staging", {}, options);
    await expectAsyncReads(readers(created.runId, options, created));
  }, options);
  expect((await getRunAsync(created.runId, options))?.phase).toBe("staging");
});

it("separates committed reads from native transactions", async () => {
  const { options, created, db } = setupRun();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE update_runs SET phase = 'staging' WHERE run_id = ?").run(created.runId);
    const cases = readers(created.runId, options, created);
    expectReads(cases);
    for (const [read] of [cases["get-async"], cases["list-async"], cases.status]) {
      await expect(read()).rejects.toThrow(
        "Asynchronous shared-state reads cannot run inside a native transaction",
      );
    }
    expect(db.isTransaction).toBe(true);
    expect(db.prepare("SELECT phase FROM update_runs WHERE run_id = ?").get(created.runId)).toEqual(
      { phase: "staging" },
    );
    db.exec("COMMIT");
  } finally {
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
  }
  expect(getRun(created.runId, options)?.phase).toBe("staging");
  expect(await getStatus(options)).toMatchObject({
    activeRun: { runId: created.runId, phase: "staging" },
    lastRun: { runId: created.runId, phase: "staging" },
  });
});

it("orders newest runs and excludes terminal active runs", async () => {
  const options = isolatedOptions();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const oldest = createRun({ trigger: "cli" }, options);
  clock.mockReturnValue(2_000);
  const tied = [
    createRun({ trigger: "api" }, options),
    createRun({ trigger: "campaign" }, options),
  ].toSorted((left, right) => right.runId.localeCompare(left.runId));
  expect(listRuns({ limit: 2 }, options)).toEqual(tied);
  expect(await listRunsAsync({ limit: 2 }, options)).toEqual(tied);
  expect(findActive(options)).toEqual(tied[0]);
  for (const run of tied) {
    finishRun(run.runId, { status: "skipped", reason: "dry-run" }, options);
  }
  expect(listRuns({ active: true }, options)).toEqual([oldest]);
  expect(await listRunsAsync({ active: true }, options)).toEqual([oldest]);
  expect(
    (await listRunsAsync({ reason: "dry-run", limit: 1, includeRunId: oldest.runId }, options)).map(
      (run) => run.runId,
    ),
  ).toEqual([tied[0]?.runId, oldest.runId]);
  finishRun(oldest.runId, { status: "succeeded" }, options);
  expect(findActive(options)).toBeUndefined();
  expect(listRuns({}, options)).toHaveLength(3);
});
