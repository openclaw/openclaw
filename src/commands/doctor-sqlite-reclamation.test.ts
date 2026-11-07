import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as sqliteSnapshots from "../infra/sqlite-snapshot-source.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { inspectDoctorSqliteReclamation } from "./doctor-sqlite-reclamation.js";

afterEach(() => vi.restoreAllMocks());

it.each([0, 1, 2])(
  "inspects auto-vacuum=%i without copying or rewriting the drained file",
  async (mode) => {
    await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
      const pathname = openOpenClawStateDatabase({ env: state.env }).path;
      await closeOpenClawStateDatabaseAsync();
      {
        using database = openNodeSqliteDatabase(pathname);
        database.exec(`PRAGMA auto_vacuum=${mode}; VACUUM;
        CREATE TABLE payload(value); INSERT INTO payload VALUES(zeroblob(1048576)); DELETE FROM payload;`);
      }
      const before = fs.readFileSync(pathname);
      const snapshots = vi.spyOn(sqliteSnapshots, "prepareSqliteReadOnlyLocation");
      const result = await inspectDoctorSqliteReclamation({
        env: state.env,
        agents: [],
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      expect(result.warnings).toEqual(
        mode === 0 ? [expect.stringContaining("openclaw doctor --state-sqlite compact")] : [],
      );
      expect(fs.readFileSync(pathname)).toEqual(before);
      expect(fs.existsSync(`${pathname}-wal`)).toBe(false);
      expect(fs.existsSync(`${pathname}-shm`)).toBe(false);
      expect(snapshots).not.toHaveBeenCalled();
    });
  },
);

it("defers recovery-page inspection without a snapshot or stale main-file decision", async () => {
  await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
    const pathname = openOpenClawStateDatabase({ env: state.env }).path;
    await closeOpenClawStateDatabaseAsync();
    using writer = openNodeSqliteDatabase(pathname);
    writer.exec(
      "PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(value); INSERT INTO payload VALUES('retained in WAL');",
    );
    const files = [pathname, `${pathname}-wal`, `${pathname}-shm`];
    const before = files.map((file) => fs.readFileSync(file));
    const snapshots = vi.spyOn(sqliteSnapshots, "prepareSqliteReadOnlyLocation");
    const result = await inspectDoctorSqliteReclamation({
      env: state.env,
      agents: [],
      signal: new AbortController().signal,
      assertCurrent() {},
    });
    expect(result.warnings).toEqual([expect.stringContaining("recovery pages remain")]);
    expect(files.map((file) => fs.readFileSync(file))).toEqual(before);
    expect(snapshots).not.toHaveBeenCalled();
  });
});
