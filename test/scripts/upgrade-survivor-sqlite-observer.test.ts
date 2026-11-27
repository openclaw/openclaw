import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync, constants } from "node:sqlite";
import type * as NativeSqlite from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import {
  installSqliteMigrationObserver,
  type SqliteMigrationObserver,
} from "../../scripts/e2e/lib/upgrade-survivor/sqlite-migration-observer.mts";
import {
  getAdmittedSqliteSchemaFacts,
  installSqliteTempTrackingSchema,
} from "../../src/infra/sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "../../src/infra/sqlite-schema-facts.test-support.js";

const { openDatabase } = useSqliteSchemaTestFixture();
const nativeSqlite: typeof NativeSqlite = createRequire(import.meta.url)("node:sqlite");
let observer: SqliteMigrationObserver | undefined;
const databases: DatabaseSync[] = [];
afterEach(() => {
  observer?.dispose();
  observer = undefined;
  for (const db of databases.splice(0)) {
    db.close();
  }
});
function fixture() {
  observer = installSqliteMigrationObserver();
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE bulk(id INTEGER); INSERT INTO bulk VALUES(1),(2)");
  return { db, guard: observer };
}

it("composes logical denial/null transitions without suspending tracked admission", async () => {
  observer = installSqliteMigrationObserver();
  const db = openDatabase("CREATE TABLE bulk(id INTEGER); INSERT INTO bulk VALUES(1)");
  await observer.observe(() => {
    expect(getAdmittedSqliteSchemaFacts(db)).toBeDefined();
    installSqliteTempTrackingSchema(db, {
      statusTable: "test_status",
      pendingTable: "test_pending",
      pendingIndex: "test_pending_idx",
      observedTables: [],
    });
    db.setAuthorizer((action, table) =>
      action === constants.SQLITE_READ && table === "bulk"
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    expect(() => db.prepare("SELECT * FROM bulk")).toThrow();
    db.setAuthorizer(null);
    expect(db.prepare("SELECT * FROM bulk").all()).toEqual([{ id: 1 }]);
    expect(getAdmittedSqliteSchemaFacts(db)).toBeDefined();
  });
  db.setAuthorizer((action, table) =>
    action === constants.SQLITE_READ && table === "bulk"
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  observer.dispose();
  expect(() => db.prepare("SELECT * FROM bulk")).toThrow();
  db.setAuthorizer(null);
  expect(db.prepare("SELECT * FROM bulk").all()).toEqual([{ id: 1 }]);
});

it("separates cached prepare intentions, execution, live reprepare and iterator consumption", async () => {
  const { db, guard } = fixture();
  const cached = db.prepare("SELECT id FROM bulk WHERE id > ?");
  db.exec("CREATE INDEX existing ON bulk(id)");
  const { observation } = await guard.observe(() => {
    db.prepare("DELETE FROM bulk WHERE 0"); // Unstepped preparation is not execution.
    const unconsumed = cached.iterate(0);
    unconsumed.return?.();
    expect(cached.all(1)).toEqual([{ id: 2 }]);
    db.exec("ALTER TABLE bulk ADD COLUMN extra TEXT DEFAULT NULL");
    expect(cached.get(0)).toEqual({ id: 1 });
    const rows = cached.iterate(0);
    expect(rows.next().value).toEqual({ id: 1 });
    rows.return?.();
    db.prepare("CREATE INDEX IF NOT EXISTS existing ON bulk(id)").run();
  });
  expect(observation.coverageFailures).toEqual([]);
  expect(observation.statements.map((entry) => entry.method)).toEqual([
    "all",
    "exec",
    "get",
    "iterate",
    "run",
  ]);
  expect(
    expectDefined(observation.statements[4], "no-op execution").preparedAuthorizations,
  ).toEqual([]);
  expect(
    expectDefined(observation.statements[0], "cached execution").preparedAuthorizations,
  ).toContainEqual(
    expect.objectContaining({
      action: constants.SQLITE_READ,
      argument1: "bulk",
    }),
  );
  expect(
    expectDefined(observation.statements[2], "reprepared execution").executedAuthorizations,
  ).toContainEqual(
    expect.objectContaining({
      action: constants.SQLITE_READ,
      argument1: "bulk",
    }),
  );
  expect(
    expectDefined(observation.statements[1], "schema change")
      .after.tables.find((table) => table.name === "bulk")
      ?.columns.map((column) => column.name),
  ).toEqual(["id", "extra"]);
  expect(expectDefined(observation.statements[0], "cached execution").sql).toBe(
    "SELECT id FROM bulk WHERE id > ?",
  );
});

it("attributes integrity only to its own async chain and rethrows original failures", async () => {
  const { db, guard } = fixture();
  const { observation } = await guard.observe(async () => {
    const owner = guard.withOwnerIntegrity("owner-check", async () => {
      await Promise.resolve();
      db.prepare("PRAGMA quick_check").all();
    });
    db.prepare("PRAGMA quick_check").all();
    await owner;
  });
  expect(observation.statements.map((entry) => entry.ownerIntegrity)).toEqual([false, true]);
  expect(observation.integrityChecks).toEqual(["owner-check"]);
  const failure = new Error("original");
  Object.freeze(failure);
  await expect(
    guard.observe(() => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(guard.readFailureObservation(failure)?.coverageFailures).toEqual([]);
});

it("fails coverage for unsupported APIs even when the chain catches their errors", async () => {
  const { db, guard } = fixture();
  const tags = db.createTagStore();
  expect(tags.all`SELECT * FROM bulk`).toHaveLength(2); // Warm cache cannot bypass observation.
  const tagRows = tags.iterate`SELECT * FROM bulk`;
  const session = db.createSession();
  try {
    for (const [api, operation] of [
      ["cached tags.all", () => tags.all`SELECT * FROM bulk`],
      ["cached tags iterator", () => tagRows.next()],
      ["createTagStore", () => db.createTagStore()],
      ["applyChangeset", () => db.applyChangeset(new Uint8Array())],
      ["loadExtension", () => db.loadExtension("never-loaded")],
      ["cached session.changeset", () => session.changeset()],
      ["cached session.patchset", () => session.patchset()],
      ["native export backup", () => nativeSqlite.backup(db, ":memory:")],
    ] as const) {
      const failure = await guard
        .observe(async () => {
          try {
            await operation();
          } catch {
            /* The observation must still reject. */
          }
        })
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error : undefined),
        );
      expect(failure?.message, api).toContain("coverage failed");
    }
  } finally {
    tagRows.return?.();
    session.close();
  }
});

it("rejects statements prepared before installation instead of inventing provenance", async () => {
  const db = new DatabaseSync(":memory:");
  const nativeExec = Reflect.get(DatabaseSync.prototype, "exec") as DatabaseSync["exec"];
  databases.push(db);
  const statement = db.prepare("SELECT 1");
  observer = installSqliteMigrationObserver();
  await expect(observer.observe(() => statement.get())).rejects.toThrow("preexisting statement");
  db.prepare("SELECT 2");
  await expect(observer.observe(() => nativeExec.call(db, "SELECT 3"))).rejects.toThrow(
    "coverage failed",
  );
  observer.dispose();
  expect(statement.get()).toEqual({ "1": 1 });
});

it("blocks migration process/isolate escapes but delegates owner integrity and restores exports", async () => {
  const guard = (observer = installSqliteMigrationObserver());
  const run = () =>
    spawnSync(process.execPath, ["-e", "process.stdout.write('owner')"], { encoding: "utf8" });
  expect(run().stdout).toBe("owner");
  await expect(
    guard.observe(() => {
      for (const operation of [run, () => new Worker("", { eval: true })]) {
        expect(operation).toThrow("Unsupported SQLite observation API");
      }
    }),
  ).rejects.toThrow("coverage failed");
  const { value } = await guard.observe(() => guard.withOwnerIntegrity("native-check", run));
  expect(value.stdout).toBe("owner");
  guard.dispose();
  expect(run().stdout).toBe("owner");
});

it("qualifies the unmodified named SQLite binding in a fresh native ESM process", () => {
  const source = pathToFileURL(
    resolve("scripts/e2e/lib/upgrade-survivor/sqlite-migration-observer.mts"),
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { installSqliteMigrationObserver } from ${JSON.stringify(source)};
    const guard = installSqliteMigrationObserver();
    try {
      await guard.qualifyNativeBindings();
      const { DatabaseSync, backup } = await import("node:sqlite");
      const db = new DatabaseSync(":memory:");
      try {
        db.exec("CREATE TABLE transcript_events(payload TEXT); INSERT INTO transcript_events VALUES('retained')");
        await assert.rejects(guard.observe(async () => {
          try { await backup(db, ":memory:"); } catch {}
        }), /coverage failed/);
      } finally { db.close(); }
    } finally { guard.dispose(); }
  `;
  // A pristine process qualifies the native binding, not Vitest's module graph.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_OPTIONS: "" },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(child.status, child.stderr).toBe(0);
});
