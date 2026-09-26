import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { readPersistedQuarantineRow } from "../state/openclaw-quarantine-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createImportedStoreForCompaction } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each(["NONE", "FULL", "INCREMENTAL"] as const)(
    "finalizes imports from auto_vacuum=%s without unnecessary repacking",
    async (autoVacuum) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      fs.writeFileSync(store.storePath, "{}\n");
      const database = nodeSqlite.openNodeSqliteDatabase(sqlitePath);
      let freelistBefore: number;
      try {
        database.exec(`PRAGMA auto_vacuum = ${autoVacuum}; VACUUM;
          CREATE TABLE cleanup_payload (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
          CREATE TABLE cleanup_discard (body BLOB);
          BEGIN;`);
        const insert = database.prepare("INSERT INTO cleanup_payload VALUES (?, ?)");
        for (let index = 0; index < 1000; index++) {
          insert.run(index, "x".repeat(1000));
        }
        // Keep partially filled pages as well as completely freed pages: only full
        // compaction should repack the former when pointer maps already exist.
        database.exec(`COMMIT; UPDATE cleanup_payload SET body = 'keep';
          INSERT INTO cleanup_discard VALUES (zeroblob(1048576));
          DELETE FROM cleanup_discard; PRAGMA wal_checkpoint(TRUNCATE);`);
        freelistBefore = Number(database.prepare("PRAGMA freelist_count").get()?.freelist_count);
      } finally {
        database.close();
      }
      const imported = await importLegacyStore(store);
      expect(imported.totals.issues).toBe(0);
      const cleanup = expectDefined(imported.targets[0]?.compact, "import cleanup");
      expect(cleanup.freelistAfterPages).toBe(0);
      if (autoVacuum !== "FULL") {
        expect(freelistBefore).toBeGreaterThan(0);
        expect(cleanup.reclaimedBytes).toBeGreaterThan(0);
      }
      const compacted = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });
      expect(compacted.totals.issues).toBe(0);
      const packed = expectDefined(compacted.targets[0]?.compact, "explicit compaction");
      if (autoVacuum === "NONE") {
        expect(packed.dbSizeAfterBytes).toBe(cleanup.dbSizeAfterBytes);
      } else {
        expect(packed.dbSizeAfterBytes).toBeLessThan(cleanup.dbSizeAfterBytes);
      }
      const after = nodeSqlite.openNodeSqliteDatabase(sqlitePath, { readOnly: true });
      try {
        expect(after.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
        expect(after.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(after.prepare("SELECT id, body FROM cleanup_payload ORDER BY id").all()).toEqual(
          Array.from({ length: 1000 }, (_, id) => ({ id, body: "keep" })),
        );
      } finally {
        after.close();
      }
    },
  );

  it("compacts migrated agent SQLite databases and reports reclaimed pages", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        ...Array.from({ length: 240 }, (_, index) =>
          JSON.stringify({
            id: `evt-${index}`,
            message: { content: "x".repeat(2_000), role: "user" },
            type: "message",
          }),
        ),
      ],
    });
    const importReport = await importLegacyStore(store);
    const sqlitePath = importReport.targets[0]?.sqlitePath;
    expect(sqlitePath).toBeTruthy();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const db = new sqlite.DatabaseSync(sqlitePath ?? "");
    try {
      db.exec("DELETE FROM transcript_events;");
    } finally {
      db.close();
    }

    const compact = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(compact.totals.issues).toBe(0);
    expect(compact.totals.reclaimedBytes).toBeGreaterThan(0);
    expect(compact.targets[0]?.compact).toMatchObject({
      freelistAfterPages: 0,
      skipped: false,
    });
    expect(compact.targets[0]?.compact?.freelistBeforePages).toBeGreaterThan(0);
    expect(compact.targets[0]?.compact?.dbSizeAfterBytes).toBeLessThan(
      compact.targets[0]?.compact?.dbSizeBeforeBytes ?? 0,
    );
  });

  it.skipIf(process.platform === "win32")(
    "allows hard-linked legacy stores during SQLite compaction",
    async () => {
      const { store } = await createImportedStoreForCompaction();
      const externalStorePath = path.join(store.tempDir, "external-sessions.json");
      fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
      fs.linkSync(store.storePath, externalStorePath);

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(fs.statSync(externalStorePath).nlink).toBe(2);
      expect(fs.readFileSync(externalStorePath, "utf8")).toBe("{}\n");
    },
  );

  it("preserves the typed maintenance cause when import finalization fails", async () => {
    const store = createLegacyStore();
    fs.writeFileSync(store.storePath, "{}\n");
    openOpenClawAgentDatabase({ agentId: "main", env: store.env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const openDatabase = nodeSqlite.openNodeSqliteDatabase;
    const sharedPath = resolveOpenClawStateSqlitePath(store.env);
    const sharedFileUri = nodeSqlite.resolveExistingSqliteFileUri(sharedPath);
    const spy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((file, options) => {
        if ((file === sharedPath || file === sharedFileUri) && !options?.readOnly) {
          throw Object.assign(new Error("fixture lease storage failure"), { code: "SQLITE_IOERR" });
        }
        return openDatabase(file, options);
      });
    try {
      const report = await importLegacyStore(store);
      expect(report.targets[0]?.issues).toContainEqual(
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringContaining("fixture lease storage failure | SQLITE_IOERR"),
        }),
      );
      expect(fs.readFileSync(store.storePath, "utf8")).toBe("{}\n");
      const failureReportPath = expectDefined(
        report.migrationRun?.failureReportMarkdownPath,
        "failure report",
      );
      expect(fs.readFileSync(failureReportPath, "utf8")).toContain(
        "fixture lease storage failure | SQLITE_IOERR",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses compaction while this process owns an open agent database handle", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    openOpenClawAgentDatabase({
      agentId: "main",
      env: store.env,
      path: sqlitePath,
    });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual([
      expect.objectContaining({
        code: "sqlite_compact_failed",
        message: expect.stringMatching(/already open in this process/iu),
      }),
    ]);
  });

  it.each([
    {
      label: "wrong schema role",
      mutate: (database: DatabaseSync) => {
        database.prepare("UPDATE schema_meta SET role = 'global' WHERE meta_key = 'primary'").run();
      },
      message: /schema role global.*expected agent/iu,
    },
    {
      label: "wrong agent owner",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE schema_meta SET agent_id = 'work' WHERE meta_key = 'primary'")
          .run();
      },
      message: /belongs to agent work.*requested agent main/iu,
    },
    {
      label: "stale metadata version",
      mutate: (database: DatabaseSync) => {
        database
          .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
          .run(OPENCLAW_AGENT_SCHEMA_VERSION - 1);
      },
      message: /metadata schema version .* does not match/iu,
    },
    {
      label: "stale user version",
      mutate: (database: DatabaseSync) => {
        database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1};`);
      },
      message: /run openclaw doctor --fix before compacting/iu,
    },
  ])("rejects $label before compaction", async ({ mutate, message }) => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    const sqlite = nodeSqlite.requireNodeSqlite();
    const database = new sqlite.DatabaseSync(sqlitePath);
    try {
      mutate(database);
    } finally {
      database.close();
    }

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringMatching(message),
        }),
      ]),
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlink at the agent database path",
    async () => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      const realPath = `${sqlitePath}.real`;
      fs.renameSync(sqlitePath, realPath);
      fs.symlinkSync(realPath, sqlitePath);

      await expect(
        runDoctorSessionSqlite({
          env: store.env,
          mode: "compact",
          store: store.storePath,
        }),
      ).rejects.toThrow(/Cannot run session SQLite compact.*symbolic-link path/iu);
    },
  );

  it("clears agent quarantine after compaction", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    expect(
      recordOpenClawDatabaseQuarantine({
        env: store.env,
        kind: "agent",
        path: sqlitePath,
        reason: "corrupt index",
      }),
    ).toBe(true);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(readPersistedQuarantineRow(sqlitePath, { env: store.env })).toBeUndefined();
    expect(openOpenClawAgentDatabase({ agentId: "main", env: store.env }).db.isOpen).toBe(true);
  });
});
