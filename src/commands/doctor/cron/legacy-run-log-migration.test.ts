import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { readCronRunHistoryPageForTests } from "../../../cron/run-history.test-support.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { migrateLegacyCronRunLogsToSqlite } from "./legacy-run-log-migration.js";

it("archives JSONL only after native history commits and imports it once", async () => {
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
      await fs.writeFile(logPath, JSON.stringify(entry) + "\n{\n");
      const database = openOpenClawStateDatabase();
      database.db.exec(
        "CREATE TRIGGER reject_history BEFORE INSERT ON task_runs BEGIN SELECT RAISE(ABORT, 'history-write-refused'); END;",
      );
      await expect(migrateLegacyCronRunLogsToSqlite(storePath)).rejects.toThrow(
        "history-write-refused",
      );
      expect(await fs.readFile(logPath, "utf8")).toContain("public-run");
      await expect(fs.stat(logPath + ".migrated")).rejects.toMatchObject({ code: "ENOENT" });
      database.db.exec("DROP TRIGGER reject_history;");
      await expect(migrateLegacyCronRunLogsToSqlite(storePath)).resolves.toEqual({
        importedFiles: 1,
      });
      await expect(fs.stat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(logPath + ".migrated", "utf8")).toContain("public-run");
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
