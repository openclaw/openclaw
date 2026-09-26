import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { getFleetCell } from "../fleet/registry.js";
import { reserveFleetCellInDatabase } from "../fleet/registry.kernel.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withArtifactPreservingStateReads } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("moves owned-native artifact token SQL off the caller while retaining its source", async () => {
  await withOpenClawTestState({ label: "owned-native-token" }, async (state) => {
    vi.stubEnv("XDG_CACHE_HOME", state.path("cache"));
    const database = openOpenClawStateDatabase({ env: state.env });
    const record = runOpenClawStateWriteTransaction(
      ({ db }) =>
        reserveFleetCellInDatabase(db, {
          tenantId: "owned-native-token",
          createdAtMs: 1,
          image: "synthetic:owned-native-token",
          runtime: "docker",
          containerName: "synthetic-owned-native-token",
          dataDir: state.path("data"),
        }),
      { database, env: state.env },
    );
    const family = () =>
      ["", "-wal", "-shm", "-journal"].map((suffix) => {
        const file = `${database.path}${suffix}`;
        return fs.existsSync(file)
          ? { suffix, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }
          : { suffix, absent: true };
      });
    const before = family();
    const shmBefore = fs.readFileSync(`${database.path}-shm`);
    const sqlite = requireNodeSqlite();
    const tokenSql: string[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its original native receiver.
    const execute = sqlite.DatabaseSync.prototype.exec;
    const observer = vi.spyOn(sqlite.DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (path.basename(this.location() ?? "") === "owner.sqlite") {
        tokenSql.push(sql);
      }
      return execute.call(this, sql);
    });
    let beforeBackup: ReturnType<typeof family> | undefined;
    let afterBackup: ReturnType<typeof family> | undefined;
    const nativeBackup = sqlite.backup.bind(sqlite);
    const backup = vi.spyOn(sqlite, "backup").mockImplementation(async (...args) => {
      beforeBackup = family();
      const result = await nativeBackup(...args);
      afterBackup = family();
      return result;
    });
    try {
      const calibration = openNodeSqliteDatabase(state.path("owner.sqlite"));
      try {
        calibration.exec("SELECT 1");
      } finally {
        calibration.close();
      }
      expect(tokenSql).toEqual(["SELECT 1"]);
      tokenSql.length = 0;

      expect(
        await withArtifactPreservingStateReads(() => getFleetCell(state.env, record.tenantId)),
      ).toEqual(record);
      expect(backup).toHaveBeenCalledOnce();
      expect(backup.mock.calls[0]?.[0]).toBe(database.db);
      expect(database.db.isOpen).toBe(true);
      const after = family();
      const shmAfter = fs.readFileSync(`${database.path}-shm`);
      const changedOffsets = [...shmBefore.keys()].filter(
        (offset) => shmBefore[offset] !== shmAfter[offset],
      );
      const observation = {
        tokenSql,
        before,
        beforeBackup,
        afterBackup,
        after,
        changedOffsets,
        readMarksBefore: shmBefore.subarray(100, 120).toString("hex"),
        readMarksAfter: shmAfter.subarray(100, 120).toString("hex"),
      };
      console.info("owned-native-token observation", JSON.stringify(observation));
      expect(beforeBackup).toEqual(before);
      expect(after).toEqual(afterBackup);
      expect(after.filter((entry) => entry.suffix !== "-shm")).toEqual(
        before.filter((entry) => entry.suffix !== "-shm"),
      );
      // The retained native backup may update only SQLite's documented WAL read marks.
      expect(shmAfter.length).toBe(shmBefore.length);
      expect(changedOffsets.every((offset) => offset >= 100 && offset < 120)).toBe(true);
      expect(tokenSql).toEqual([]);
    } finally {
      observer.mockRestore();
      backup.mockRestore();
      await closeOpenClawStateDatabaseAsync();
      await cleanupSnapshotOperations();
    }
  });
});
