import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { readBackupRunFreshness } from "../state/backup-run-records.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";

describe("registered backup hardlinks", () => {
  it.each([
    { role: "agent", aliasName: "a-alias.sqlite", journal: "one WAL" },
    { role: "agent", aliasName: "z-alias.sqlite", journal: "one WAL" },
    { role: "agent", aliasName: "a-alias.sqlite", journal: "competing WALs" },
    { role: "agent", aliasName: "a-alias.sqlite", journal: "rollback journal" },
    { role: "global", aliasName: "a-alias.sqlite", journal: "one WAL" },
    { role: "global", aliasName: "z-alias.sqlite", journal: "one WAL" },
    { role: "global", aliasName: "a-alias.sqlite", journal: "competing WALs" },
  ])(
    "preserves committed rows or refuses unsafe $journal ($role, $aliasName)",
    async ({ role, aliasName, journal }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "backup-registered-hardlinks-", scenario: "minimal" },
        async (state) => {
          const ownerPath =
            role === "global"
              ? resolveOpenClawStateSqlitePath(state.env)
              : path.join(state.agentDir(), "openclaw-agent.sqlite");
          const aliasPath = path.join(path.dirname(ownerPath), aliasName);
          const owner =
            role === "global"
              ? openOpenClawStateDatabase({ env: state.env })
              : openOpenClawAgentDatabase({ agentId: "main", path: ownerPath, env: state.env });
          owner.db.exec("CREATE TABLE durable_records (value TEXT NOT NULL)");
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabase();
          await fs.link(ownerPath, aliasPath);
          if (role === "agent") {
            registerOpenClawAgentDatabase({ agentId: "main", path: aliasPath, env: state.env });
            closeOpenClawStateDatabase();
          }
          const sqlite = requireNodeSqlite();
          const writer = new sqlite.DatabaseSync(ownerPath);
          try {
            writer.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            INSERT INTO durable_records VALUES ('committed-only-in-wal');
          `);
            expect((await fs.stat(`${ownerPath}-wal`)).size).toBeGreaterThan(0);
            await expect(fs.stat(`${aliasPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
            if (journal === "competing WALs") {
              await fs.copyFile(`${ownerPath}-wal`, `${aliasPath}-wal`);
            } else if (journal === "rollback journal") {
              await fs.writeFile(`${aliasPath}-journal`, "unsettled journal");
            }
            const output = state.path("backup.tar.gz");
            const runtime = createTestRuntime();
            const create = () =>
              backupCreateCommand(runtime, { output, includeWorkspace: false, verify: true });
            if (journal !== "one WAL") {
              const reason =
                journal === "competing WALs"
                  ? /Ambiguous SQLite hardlink journal ownership: multiple non-empty WAL/iu
                  : /journal ownership.*rollback journal is present/iu;
              await expect(create()).rejects.toThrow(reason);
              expect((await readBackupRunFreshness(state.env)).latest).toMatchObject({
                status: "failed",
                error: expect.stringMatching(reason),
              });
              await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
              return;
            }
            const archive = await create();
            expect(archive.verified).toBe(true);
            const restored = await backupRestoreCommand(runtime, {
              archive: archive.archivePath,
              target: state.path("restored"),
            });
            for (const source of [ownerPath, aliasPath]) {
              const database = new sqlite.DatabaseSync(
                path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, source)),
                { readOnly: true },
              );
              try {
                expect(database.prepare("SELECT value FROM durable_records").all()).toEqual([
                  { value: "committed-only-in-wal" },
                ]);
              } finally {
                database.close();
              }
            }
          } finally {
            writer.close();
          }
        },
      );
    },
  );
});
