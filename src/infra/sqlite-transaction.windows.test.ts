import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  runSqliteImmediateTransactionSync,
  withSqliteWriteAdmissionService,
} from "./sqlite-transaction.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([String.raw`C:\OpenClaw\agent.sqlite`, String.raw`\\Server\Share\agent.sqlite`])(
  "services a held write lock across native namespace aliases of %s",
  async (plain) => {
    const filename = path.join(dirs.make("sqlite-windows-admission-"), "agent.sqlite");
    const reader = new DatabaseSync(filename);
    const writer = new DatabaseSync(filename);
    try {
      reader.exec("CREATE TABLE proof(value TEXT); PRAGMA busy_timeout=100");
      writer.exec("BEGIN IMMEDIATE");
      // Native SQLite locking stays real; supply the two measured Windows filename spellings.
      vi.spyOn(reader, "location").mockReturnValue(plain);
      vi.spyOn(writer, "location").mockReturnValue(path.win32.toNamespacedPath(plain));
      mockProcessPlatform("win32");
      const release = vi.fn(() => writer.exec("COMMIT"));
      await withSqliteWriteAdmissionService(writer, release, async () => {
        runSqliteImmediateTransactionSync(reader, () => {
          reader.prepare("INSERT INTO proof VALUES (?)").run("committed");
        });
      });
      expect(release).toHaveBeenCalledOnce();
      expect(reader.prepare("SELECT value FROM proof").all()).toEqual([{ value: "committed" }]);
      // Removing the last service must remove it for both spellings.
      writer.exec("BEGIN IMMEDIATE");
      expect(() => runSqliteImmediateTransactionSync(reader, () => undefined)).toThrow(
        "database is locked",
      );
      expect(release).toHaveBeenCalledOnce();
    } finally {
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      reader.close();
    }
  },
);
