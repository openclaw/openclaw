import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readSqliteDatabaseWriteTokenForPath } from "./sqlite-database-admission.js";
import { stageSqliteCommittedPublication } from "./sqlite-post-commit.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";
import {
  runSqliteImmediateTransactionSync,
  runSqliteSingleStatementSync,
} from "./sqlite-transaction.js";

describe("single-statement settlement", () => {
  const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();

  it("publishes committed rows and advances the path write token without an envelope", () => {
    const filename = path.join(tempDirs.make("sqlite-single-statement-"), "state.sqlite");
    const writer = openDatabase(
      "CREATE TABLE entries (value INTEGER CHECK (value > 0))",
      true,
      filename,
    );
    const reader = openDatabase("", true, filename);
    const read = () => reader.prepare("SELECT value FROM entries").all();
    const receipts: Array<{ token: string | undefined; rows: ReturnType<typeof read> }> = [];
    let installedToken: string | undefined;
    writer.function("receipt", (value) => {
      stageSqliteCommittedPublication(writer, {
        installFacts: () => {
          installedToken = readSqliteDatabaseWriteTokenForPath(filename);
        },
        invalidate: () => {
          installedToken = undefined;
        },
        notify: () => receipts.push({ token: installedToken, rows: read() }),
      });
      return value;
    });
    const before = readSqliteDatabaseWriteTokenForPath(filename);
    expect(before).toBeTypeOf("string");
    const controls = vi.spyOn(writer, "exec");
    runSqliteSingleStatementSync(writer, () =>
      writer.prepare("INSERT INTO entries VALUES (receipt(1))").run(),
    );
    expect(receipts).toEqual([{ token: installedToken, rows: [{ value: 1 }] }]);
    expect(installedToken).toBeTypeOf("string");
    expect(installedToken).not.toBe(before);
    const first = installedToken;

    expect(() =>
      runSqliteSingleStatementSync(writer, () =>
        writer.prepare("UPDATE entries SET value = receipt(-1)").run(),
      ),
    ).toThrow(/CHECK constraint/);
    expect(receipts).toHaveLength(1);
    expect(read()).toEqual([{ value: 1 }]);

    runSqliteSingleStatementSync(writer, () =>
      writer.prepare("UPDATE entries SET value = receipt(2)").run(),
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toEqual({ token: installedToken, rows: [{ value: 2 }] });
    expect(installedToken).not.toBe(first);
    expect(controls).not.toHaveBeenCalled();
    controls.mockRestore();
  });

  it("leaves nested publications and writes with the outer rollback owner", () => {
    const db = openDatabase("CREATE TABLE entries (value INTEGER)");
    const published: number[] = [];
    db.function("receipt", (value) => {
      stageSqliteCommittedPublication(db, {
        installFacts: () => {},
        invalidate: () => {},
        notify: () => published.push(Number(value)),
      });
      return value;
    });
    expect(() =>
      runSqliteImmediateTransactionSync(db, () => {
        runSqliteSingleStatementSync(db, () =>
          db.prepare("INSERT INTO entries VALUES (receipt(1))").run(),
        );
        expect(published).toEqual([]);
        throw new Error("outer write refused");
      }),
    ).toThrow("outer write refused");
    expect(db.prepare("SELECT value FROM entries").all()).toEqual([]);
    expect(published).toEqual([]);
    runSqliteImmediateTransactionSync(db, () => {
      runSqliteSingleStatementSync(db, () =>
        db.prepare("INSERT INTO entries VALUES (receipt(2))").run(),
      );
      expect(published).toEqual([]);
    });
    expect(published).toEqual([2]);
  });
});
