// Tests for SQLite user_version pragma helper.
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";

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

it.each(["runtime", "doctor-maintenance"] as const)("handles %s writers", (kind) => {
  // A source build of main can write a newer schema under an equal, lower, or unrecognized label (#200886).
  for (const writer of ["9999.1.1", VERSION, "2000.1.1", "2026.11.6-dev.1", undefined]) {
    const newer = writer === "9999.1.1";
    const error = createNewerSqliteSchemaVersionError("db", "/tmp/db", 12, 11, writer, kind);

    expect(error.name).toBe("SqliteSchemaVersionError");
    expect(error.message).toContain("https://docs.openclaw.ai/reference/database-schemas");
    expect(error.message).toMatch(/uses newer schema version 12; this build supports 11/);
    expect(error.message).toContain(`OpenClaw ${VERSION} (aaaaaaa) installed at `);
    expect(error.message).toContain("supports schema 12 or newer");
    expect(error.message).toMatch(/restore your pre-update backup.*openclaw backup create/);
    // Two builds sharing one release version can support different schemas (#115008).
    expect(error.message).not.toMatch(/Do not downgrade|Upgrade OpenClaw/);
    expect(error.message.includes("newer than this Gateway")).toBe(newer);
    // The schema is newer whatever the writer label says, so Doctor cannot repair it.
    expect(error.message).not.toContain("doctor --fix");
    const writerShown =
      kind === "runtime" ? Boolean(writer) : Boolean(writer) && writer !== VERSION;
    expect(error.message.includes("It was written")).toBe(writerShown);
    expect(error.message.includes("a different build with a newer schema")).toBe(
      writerShown && !newer,
    );
    if (kind === "runtime") {
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
      expect(preflight.message.includes("Use a build that supports these schemas")).toBe(!newer);
      expect(preflight.message).not.toContain("at least as new as the writer");
    }
  }
});
