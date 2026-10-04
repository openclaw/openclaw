import { copyFileSync, openSync, realpathSync, renameSync, writeSync, closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertExistingOpenClawStateRuntimeSchema } from "./openclaw-state-db-existing-schema.js";
import { isOpenClawStateSchemaFastPathEligible } from "./openclaw-state-db-fast-path.js";
import {
  closeTrackedStateDatabase,
  openTrackedStateDatabase,
} from "./openclaw-state-db-handle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function createStateDatabase(prefix: string): string {
  const env = { OPENCLAW_STATE_DIR: dirs.make(prefix) };
  const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

function countFullIntegrityChecks(): { readonly count: number } {
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its exact database receiver.
  const prepare = DatabaseSync.prototype.prepare;
  const counter = { count: 0 };
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (/^PRAGMA integrity_check;?$/u.test(sql)) {
      counter.count += 1;
    }
    return Reflect.apply(prepare, this, [sql]);
  });
  return counter;
}

// Receipts name the file the handle owner bound at open time, so admission in a test has to come
// through that owner exactly as production admission does.
function withFreshConnection<T>(pathname: string, run: (database: DatabaseSync) => T): T {
  const database = openTrackedStateDatabase(pathname, { readOnly: true });
  try {
    return run(database);
  } finally {
    closeTrackedStateDatabase(database);
  }
}

function replaceWithCopy(source: string, target: string): void {
  copyFileSync(source, target + ".replacement");
  renameSync(target + ".replacement", target);
}

function corruptCopy(source: string, target: string): void {
  copyFileSync(source, target);
  const pageSize = withFreshConnection(source, (database) => {
    const row = database.prepare("PRAGMA page_size").get() as { page_size: number };
    return row.page_size;
  });
  const fd = openSync(target, "r+");
  try {
    // Page 2 is a schema b-tree page in a fresh state database; garbage there fails integrity_check.
    writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, pageSize);
  } finally {
    closeSync(fd);
  }
}

async function fastPathInFreshWorker(
  pathname: string,
): Promise<{ checks: number; eligible: boolean }> {
  const fastPathUrl = new URL("./openclaw-state-db-fast-path.ts", import.meta.url).href;
  const handleUrl = new URL("./openclaw-state-db-handle.ts", import.meta.url).href;
  const source = [
    'const { parentPort, workerData } = await import("node:worker_threads");',
    'const { DatabaseSync } = await import("node:sqlite");',
    "let checks = 0;",
    "const prepare = DatabaseSync.prototype.prepare;",
    "DatabaseSync.prototype.prepare = function (sql, ...rest) {",
    "  if (/^PRAGMA integrity_check;?$/u.test(sql)) checks += 1;",
    "  return prepare.call(this, sql, ...rest);",
    "};",
    "const { isOpenClawStateSchemaFastPathEligible } = await import(workerData.fastPathUrl);",
    "const { openTrackedStateDatabase, closeTrackedStateDatabase } = await import(workerData.handleUrl);",
    "const database = openTrackedStateDatabase(workerData.pathname, { readOnly: true });",
    "try {",
    "  const eligible = isOpenClawStateSchemaFastPathEligible(database, workerData.pathname);",
    "  parentPort.postMessage({ checks, eligible });",
    "} finally {",
    "  closeTrackedStateDatabase(database);",
    "}",
  ].join("\n");
  const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(source)), {
    execArgv: ["--import", import.meta.resolve("tsx")],
    workerData: { pathname, fastPathUrl, handleUrl },
  });
  try {
    return await new Promise<{ checks: number; eligible: boolean }>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  } finally {
    await worker.terminate();
  }
}

describe("shared-state full integrity proof reuse", () => {
  it("runs the full integrity check once per process for an unchanged database across fresh connections", () => {
    const pathname = createStateDatabase("state-integrity-receipt-reuse-");
    const checks = countFullIntegrityChecks();

    expect(
      withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname)),
    ).toBe(true);
    expect(checks.count).toBe(1);
    expect(
      withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname)),
    ).toBe(true);
    withFreshConnection(pathname, (db) => assertExistingOpenClawStateRuntimeSchema(db, pathname));

    expect(checks.count).toBe(1);
  });

  it("lets a fresh worker thread reuse the proof instead of rescanning the whole file", async () => {
    const pathname = createStateDatabase("state-integrity-receipt-worker-");
    withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname));

    await expect(fastPathInFreshWorker(pathname)).resolves.toEqual({ checks: 0, eligible: true });
  });

  it("runs the full check again for a replaced file", () => {
    const pathname = createStateDatabase("state-integrity-receipt-replaced-");
    withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname));
    const checks = countFullIntegrityChecks();

    replaceWithCopy(pathname, pathname);
    withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname));

    expect(checks.count).toBe(1);
  });

  it("rejects a corrupted replacement and forgets earlier proofs", () => {
    const pathname = createStateDatabase("state-integrity-receipt-corrupt-");
    const pristine = pathname + ".pristine";
    copyFileSync(pathname, pristine);
    const corrupted = pathname + ".corrupted";
    corruptCopy(pathname, corrupted);
    withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname));

    replaceWithCopy(corrupted, pathname);
    expect(() =>
      withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname)),
    ).toThrow(/integrity_check|malformed|corrupt/iu);
    expect(() =>
      withFreshConnection(pathname, (db) => assertExistingOpenClawStateRuntimeSchema(db, pathname)),
    ).toThrow(/integrity_check|malformed|corrupt/iu);

    const checks = countFullIntegrityChecks();
    replaceWithCopy(pristine, pathname);
    withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname));
    expect(checks.count).toBe(1);
  });

  it("does not mint a reusable proof from a check nested in a caller transaction", () => {
    const pathname = createStateDatabase("state-integrity-receipt-nested-");
    const checks = countFullIntegrityChecks();

    withFreshConnection(pathname, (db) => {
      db.exec("BEGIN");
      try {
        isOpenClawStateSchemaFastPathEligible(db, pathname);
      } finally {
        db.exec("ROLLBACK");
      }
    });
    withFreshConnection(pathname, (db) => isOpenClawStateSchemaFastPathEligible(db, pathname));

    expect(checks.count).toBe(2);
  });
});
