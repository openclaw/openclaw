// Tests for SQLite user_version pragma helper.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../version.js")>();
  return { ...actual, resolveRuntimeServiceCommit: () => "aaaaaaa" };
});
import { VERSION } from "../version.js";
import { enableNodeSqliteKyselyStatementCache } from "./kysely-sync-cache-state.js";
import {
  createNewerSqliteSchemaVersionError,
  describeRunningOpenClawBuild,
  readSqliteUserVersion,
} from "./sqlite-user-version.js";

describe("readSqliteUserVersion", () => {
  it.each([false, true])(
    "reads fresh versions and only reuses statements when enabled=%s",
    (cacheEnabled) => {
      const db = new DatabaseSync(":memory:");
      try {
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
      } finally {
        db.close();
      }
    },
  );
});

describe("createNewerSqliteSchemaVersionError", () => {
  it("returns a stable named error with the schema guide", () => {
    const error = createNewerSqliteSchemaVersionError("test database", "/tmp/test.sqlite", 12, 11);

    expect(error.name).toBe("SqliteSchemaVersionError");
    expect(error.message).toContain("https://docs.openclaw.ai/reference/database-schemas");
  });

  it("names the refusing install and both schema versions", () => {
    const error = createNewerSqliteSchemaVersionError("test database", "/tmp/test.sqlite", 12, 11);

    expect(error.message).toContain("uses newer schema version 12");
    expect(error.message).toContain("this build supports 11");
    expect(error.message).toContain(describeRunningOpenClawBuild());
    expect(error.message).toContain("supports schema 12 or newer");
    expect(error.message).toContain(
      "restore your pre-update backup created with openclaw backup create.",
    );
  });

  it("does not assert a downgrade the operator never performed", () => {
    // Two builds sharing one release version can support different schemas (#115008).
    // Telling the operator to upgrade or stop downgrading is unactionable and often wrong.
    const error = createNewerSqliteSchemaVersionError("test database", "/tmp/test.sqlite", 12, 11);

    expect(error.message).not.toContain("Do not downgrade");
    expect(error.message).not.toContain("Upgrade OpenClaw");
  });
});

describe("describeRunningOpenClawBuild", () => {
  it("reports the version and the install root operators can act on", () => {
    const described = describeRunningOpenClawBuild();

    expect(described).toContain(VERSION);
    expect(described).toContain("installed at ");
  });

  it("reports the loaded build commit", () => {
    expect(describeRunningOpenClawBuild()).toContain("(aaaaaaa)");
  });
});
