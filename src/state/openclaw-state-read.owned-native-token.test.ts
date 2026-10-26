import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recordBackupRunOutcome } from "./backup-run-records.js";
import {
  executeExistingOpenClawStateRead as read,
  withArtifactPreservingStateReads as preserve,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as close,
  openOpenClawStateDatabase as open,
} from "./openclaw-state-db.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("moves owned-native artifact token SQL off the caller while retaining its source", () =>
  withOpenClawTestState({ label: "owned-native-token" }, async (state) => {
    vi.stubEnv("XDG_CACHE_HOME", state.path("cache"));
    const database = open({ env: state.env });
    const record = {
      createdAt: 1,
      archivePath: state.path("backup.tar.gz"),
      status: "ok",
      kind: "archive",
    } as const;
    await recordBackupRunOutcome({ ...record, env: state.env });
    const family = () =>
      ["", "-wal", "-shm", "-journal"].map((suffix) => {
        const file = `${database.path}${suffix}`;
        if (!fs.existsSync(file)) {
          return { suffix, absent: true };
        }
        const bytes = fs.readFileSync(file);
        // Native backups may change only SQLite's documented WAL read marks.
        if (suffix === "-shm") {
          bytes.fill(0, 100, 120);
        }
        return { suffix, bytes };
      });
    const before = family();
    const sqlite = requireNodeSqlite();
    const tokenSql: string[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its original native receiver.
    const execute = sqlite.DatabaseSync.prototype.exec;
    vi.spyOn(sqlite.DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (path.basename(this.location() ?? "") === "owner.sqlite") {
        tokenSql.push(sql);
      }
      return execute.call(this, sql);
    });
    try {
      {
        using calibration = openNodeSqliteDatabase(state.path("owner.sqlite"));
        calibration.exec("SELECT 1");
      }
      expect(tokenSql).toEqual(["SELECT 1"]);
      tokenSql.length = 0;

      expect(await preserve(() => read({ env: state.env }, { type: "backup.runs" }))).toEqual({
        ok: true,
        type: "backup.runs",
        sourceAdmitted: true,
        runs: [expect.objectContaining(record)],
      });
      expect(family()).toEqual(before);
      expect({ open: database.db.isOpen, tokenSql }).toEqual({ open: true, tokenSql: [] });
    } finally {
      vi.restoreAllMocks();
      await close();
      await cleanupSnapshotOperations();
    }
  }));
