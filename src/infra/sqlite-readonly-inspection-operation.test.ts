import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

vi.mock("./node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase: vi.fn(actual.openNodeSqliteDatabase),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
  // Runtime setup can preload SQLite owners before this file's native-open mock.
  vi.resetModules();
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

async function inspectFailure(
  operation: "backup-source" | "snapshot-open" | "snapshot-copy" | "snapshot-backup",
  failure: Error,
) {
  const root = tempDirs.make("sqlite-inspection-operation-");
  const sourcePath = path.join(root, "source.sqlite");
  const stagingRoot = path.join(root, "staging");
  fs.mkdirSync(stagingRoot);
  const actual = await vi.importActual<typeof import("./node-sqlite.js")>("./node-sqlite.js");
  const source = actual.openNodeSqliteDatabase(sourcePath);
  source.exec("CREATE TABLE present (id INTEGER PRIMARY KEY); INSERT INTO present VALUES (7);");
  source.close();
  const before = fs.readFileSync(sourcePath);
  const sqlite = await import("./node-sqlite.js");
  const opened: DatabaseSync[] = [];
  vi.mocked(sqlite.openNodeSqliteDatabase).mockImplementation((location, options) => {
    if (
      (operation === "backup-source" && location === sourcePath) ||
      (operation === "snapshot-open" &&
        path.dirname(location).startsWith(stagingRoot) &&
        path.basename(location) === "database.sqlite.partial")
    ) {
      throw failure;
    }
    const database = actual.openNodeSqliteDatabase(location, options);
    opened.push(database);
    return database;
  });
  if (operation === "snapshot-backup") {
    vi.spyOn(actual.requireNodeSqlite(), "backup").mockRejectedValue(failure);
  }
  if (operation === "snapshot-copy") {
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (args[1] === "wx") {
        throw failure;
      }
      return open(...args);
    });
  }
  const diagnostics = await import("./sqlite-error-diagnostics.js");
  const format = vi.spyOn(diagnostics, "formatSqliteReadOnlyInspectionFailure");
  const completed = createDeferred();
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
    completed.resolve();
    return true;
  });
  process.argv = [
    process.execPath,
    "sqlite-readonly-location.worker.ts",
    "--openclaw-sqlite-readonly-child",
    operation === "snapshot-copy" ? "sync" : "async",
    sourcePath,
    stagingRoot,
  ];
  await import("./sqlite-readonly-location.worker.js");
  await completed.promise;
  expect(process.exitCode).toBe(1);
  expect(format).toHaveBeenCalledOnce();
  const [observedFailure] = expectDefined(format.mock.calls[0], "inspection failure");
  expect(opened.every((database) => !database.isOpen)).toBe(true);
  expect(fs.readdirSync(stagingRoot)).toEqual([]);
  expect(fs.readFileSync(sourcePath)).toEqual(before);
  const read = actual.openNodeSqliteDatabase(sourcePath, { readOnly: true });
  try {
    expect(read.prepare("SELECT id FROM present").get()).toEqual({ id: 7 });
    expect(read.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    read.close();
  }
  return { write, observedFailure };
}

describe("registered SQLite read-only worker operation diagnostics", () => {
  it.each([
    ["backup-source", "opening the source database"],
    ["snapshot-open", "creating its private snapshot"],
    ["snapshot-copy", "creating its private snapshot"],
    ["snapshot-backup", "creating its private snapshot"],
  ] as const)(
    "preserves frozen %s failures, identity, native codes and cleanup",
    async (operation, context) => {
      const failure = Object.freeze(
        Object.assign(new Error("unable to open database file"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 14,
          cause: new Error("hidden cause prose"),
          sql: "hidden SQL",
          path: "hidden path",
        }),
      );
      const { write, observedFailure } = await inspectFailure(operation, failure);
      expect(observedFailure).toBe(failure);
      expect(write).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          ok: false,
          message: `failed while ${context}: unable to open database file (code=ERR_SQLITE_ERROR, errcode=14)`,
        }),
      );
    },
  );

  it("keeps aggregate identity through staging and admits only bounded cause codes through the registered worker", async () => {
    const cause = Object.assign(new Error("hidden cause prose"), { code: "EIO", errcode: 778 });
    const failure = Object.freeze(
      new AggregateError([cause, new Error("hidden cleanup")], "read failed", { cause }),
    );
    const { write, observedFailure } = await inspectFailure("backup-source", failure);
    expect(observedFailure instanceof Error && observedFailure.cause).toBe(failure);
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "failed while opening the source database: read failed (SQLite errcode=778)",
      ),
    );
    const [message] = expectDefined(write.mock.calls[0], "worker output");
    expect(message).toContain("code=EIO, errcode=778");
    expect(message).not.toContain("hidden cause prose");
    expect(message).not.toContain("hidden cleanup");
  });

  it("keeps the source operation through the snapshot owner's existing staging wrapper", async () => {
    const failure = Object.freeze(
      Object.assign(new Error("disk full"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 13,
        cause: new Error("hidden cause prose"),
      }),
    );
    const { write, observedFailure } = await inspectFailure("backup-source", failure);
    expect(observedFailure instanceof Error && observedFailure.cause).toBe(failure);
    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "failed while opening the source database: disk full (SQLite errcode=13)",
      ),
    );
    const [message] = expectDefined(write.mock.calls[0], "worker output");
    expect(message).toContain("code=ERR_SQLITE_ERROR, errcode=13");
    expect(message).not.toContain("hidden cause prose");
  });
});
