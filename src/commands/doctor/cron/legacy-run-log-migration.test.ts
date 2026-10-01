import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { readCronRunHistoryPageForTests } from "../../../cron/run-history.test-support.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { migrateLegacyCronRunLogsToSqlite } from "./legacy-run-log-migration.js";

it("archives JSONL after native history commits without replacing an earlier archive", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-jsonl-history-" },
    async (state) => {
      const storePath = state.path("cron", "jobs.json");
      const runsPath = state.path("cron", "runs");
      const logPath = state.path("cron", "runs", "legacy.jsonl");
      await fs.mkdir(runsPath, { recursive: true });
      const entry = {
        jobId: "legacy",
        ts: 20,
        action: "finished",
        status: "ok",
        runAtMs: 10,
        runId: "public-run",
        summary: "kept",
      };
      const original = Buffer.concat([
        Buffer.from(JSON.stringify(entry) + "\n{\n"),
        Buffer.from([0xff]),
      ]);
      await fs.writeFile(logPath, original);
      await fs.writeFile(logPath + ".migrated", "previous archive\n");
      const database = openOpenClawStateDatabase();
      database.db.exec(
        "CREATE TRIGGER reject_history BEFORE INSERT ON task_runs BEGIN SELECT RAISE(ABORT, 'history-write-refused'); END;",
      );
      await expect(migrateLegacyCronRunLogsToSqlite(storePath)).rejects.toThrow(
        "history-write-refused",
      );
      expect(await fs.readFile(logPath)).toEqual(original);
      expect(await fs.readFile(logPath + ".migrated", "utf8")).toBe("previous archive\n");
      await expect(fs.stat(logPath + ".migrated.2")).rejects.toMatchObject({ code: "ENOENT" });
      database.db.exec("DROP TRIGGER reject_history;");
      await expect(migrateLegacyCronRunLogsToSqlite(storePath)).resolves.toEqual({
        importedFiles: 1,
      });
      await expect(fs.stat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(logPath + ".migrated", "utf8")).toBe("previous archive\n");
      expect(await fs.readFile(logPath + ".migrated.2")).toEqual(original);
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: "legacy" })
          .entries,
      ).toMatchObject([entry]);
      await expect(migrateLegacyCronRunLogsToSqlite(storePath)).resolves.toEqual({
        importedFiles: 0,
      });
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: "legacy" })
          .total,
      ).toBe(1);
    },
  );
});
