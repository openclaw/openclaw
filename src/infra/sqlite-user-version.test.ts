// Tests for SQLite user_version pragma helper.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../version.js")>();
  return { ...actual, resolveRuntimeServiceCommit: () => "aaaaaaa" };
});
import { OpenClawDatabaseSchemaPreflightError } from "../state/openclaw-database-preflight.messages.js";
import { VERSION } from "../version.js";
import { enableNodeSqliteKyselyStatementCache } from "./kysely-sync-cache-state.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
  writeSqliteUserVersion,
} from "./sqlite-user-version.js";

describe("writeSqliteUserVersion", () => {
  it("writes signed 32-bit versions inside a transaction and rejects values that SQLite would truncate", () => {
    using db = new DatabaseSync(":memory:");
    db.exec("BEGIN");
    for (const version of [0, 7, 2147483647]) {
      writeSqliteUserVersion(db, version);
      expect(readSqliteUserVersion(db)).toBe(version);
    }
    for (const version of [-1, 1.5, 2147483648, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => writeSqliteUserVersion(db, version)).toThrow(RangeError);
      expect(readSqliteUserVersion(db)).toBe(2147483647);
    }
    db.exec("ROLLBACK");
    expect(readSqliteUserVersion(db)).toBe(0);
  });
});

describe("readSqliteUserVersion", () => {
  it.each([false, true])(
    "reads fresh versions and only reuses statements when enabled=%s",
    (cacheEnabled) => {
      using db = new DatabaseSync(":memory:");
      if (cacheEnabled) {
        enableNodeSqliteKyselyStatementCache(db);
      }
      const prepare = vi.spyOn(db, "prepare");
      expect(readSqliteUserVersion(db)).toBe(0);
      for (const version of [5, 3, 0]) {
        db.exec(`PRAGMA user_version = ${version}`);
        expect(readSqliteUserVersion(db)).toBe(version);
      }
      db.exec("BEGIN; PRAGMA user_version = 9");
      expect(readSqliteUserVersion(db)).toBe(9);
      db.exec("ROLLBACK");
      expect(readSqliteUserVersion(db)).toBe(0);
      if (cacheEnabled) {
        expect(prepare.mock.calls.length).toBeLessThan(6);
      } else {
        expect(prepare).toHaveBeenCalledTimes(6);
      }
    },
  );
});

it.each(["9999.1.0", VERSION, undefined])("handles schema writer %s", (writer) => {
  const newer = writer === "9999.1.0";
  const error = createNewerSqliteSchemaVersionError("test", "/tmp/test.sqlite", 12, 11, writer);

  expect(error.name).toBe("SqliteSchemaVersionError");
  expect(error.message).toContain("https://docs.openclaw.ai/reference/database-schemas");
  expect(error.message).toContain("uses newer schema version 12");
  expect(error.message).toContain("this build supports 11");
  expect(error.message).toContain(`OpenClaw ${VERSION} (aaaaaaa) installed at `);
  expect(error.message).toContain("supports schema 12 or newer");
  expect(error.message).toContain("restore your pre-update backup");
  expect(error.message).toContain("openclaw backup create");
  // Two builds sharing one release version can support different schemas (#115008).
  expect(error.message).not.toMatch(/Do not downgrade|Upgrade OpenClaw/);
  expect(error.message.includes("newer than this Gateway")).toBe(newer);
  expect(error.message.includes("doctor --fix")).toBe(writer === VERSION);
  const preflight = new OpenClawDatabaseSchemaPreflightError([
    {
      kind: "state",
      path: "/tmp/test.sqlite",
      foundVersion: 12,
      supportedVersion: 11,
      writerAppVersion: writer,
    },
  ]);
  expect(preflight.message.includes("newer than this Gateway")).toBe(newer);
  expect(preflight.message.includes("Use the newer install")).toBe(newer);
});
