import fs from "node:fs";
import path from "node:path";
import sqlite, { type DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeRepairProgressIntegrity,
  resolveRepairProgressEntrypoint,
} from "../../scripts/e2e/lib/upgrade-survivor/repair-progress-probe.mjs";
import { readWorkerCellPackageIdentity } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import {
  assertSqliteIntegrity,
  assertSqliteTableIntegrity,
} from "../../src/infra/sqlite-integrity.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

it("observes the real full integrity statement without intercepting quick or table checks", () => {
  const observed = vi.fn();
  const restore = observeRepairProgressIntegrity(observed);
  let database: DatabaseSync | undefined;
  try {
    database = new sqlite.DatabaseSync(":memory:");
    database.exec("CREATE TABLE probe(value TEXT)");
    expect(assertSqliteIntegrity(database, "progress probe")).toEqual({ integrityCheck: "ok" });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(assertSqliteIntegrity(database, "progress probe", "quick_check")).toEqual({
      integrityCheck: "ok",
    });
    assertSqliteTableIntegrity(database, "progress probe", "probe");
    expect(observed).toHaveBeenCalledTimes(1);
  } finally {
    restore();
    database?.close();
  }
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("ignores lifecycle scripts without relaxing installed runtime identity", () => {
  const root = fs.realpathSync(dirs.make("progress-entry-identity-"));
  fs.mkdirSync(path.join(root, "dist/infra"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.8" }),
  );
  fs.writeFileSync(
    path.join(root, "dist/build-info.json"),
    JSON.stringify({ version: "2026.9.8", commit: "a".repeat(40) }),
  );
  const launcher = path.join(root, "openclaw.mjs");
  const worker = path.join(root, "dist/infra/sqlite-integrity.worker.js");
  const lifecycle = path.join(root, "scripts/preinstall-package-manager-warning.mjs");
  for (const file of [launcher, worker, lifecycle]) {
    fs.writeFileSync(file, "export {};\n");
  }
  const expected = readWorkerCellPackageIdentity(root);
  expect(resolveRepairProgressEntrypoint(lifecycle, [expected])).toBeUndefined();
  expect(resolveRepairProgressEntrypoint(launcher, [expected])?.identity.entry).toBe(
    "openclaw.mjs",
  );
  expect(resolveRepairProgressEntrypoint(worker, [expected])?.identity.entry).toBe(
    "dist/infra/sqlite-integrity.worker.js",
  );
  fs.appendFileSync(worker, "// changed runtime bytes\n");
  expect(() => resolveRepairProgressEntrypoint(worker, [expected])).toThrow();
  const unlisted = path.join(root, "dist/unlisted-runtime.js");
  fs.writeFileSync(unlisted, "export {};\n");
  expect(() => resolveRepairProgressEntrypoint(unlisted, [expected])).toThrow();
});
