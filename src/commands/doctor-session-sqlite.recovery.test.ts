import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
import { createTranscriptEventReader } from "../infra/session-sqlite-migration-readers.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each(["corrupt", "orphaned", "rename-failure"] as const)(
    "recovers the complete SQLite file set (%s)",
    async (state) => {
      const { sqlitePath, recover } = createRecoveryStore();
      const files = new Map([
        [sqlitePath, "not a sqlite database\n"],
        [`${sqlitePath}-wal`, "wal"],
        [`${sqlitePath}-shm`, "shm"],
        [`${sqlitePath}-journal`, "journal"],
      ]);
      if (state === "orphaned") {
        files.delete(sqlitePath);
        files.delete(`${sqlitePath}-shm`);
      }
      for (const [file, contents] of files) {
        fs.writeFileSync(file, contents, {
          mode:
            state === "corrupt" && file === sqlitePath && process.platform !== "win32"
              ? 0o400
              : 0o600,
        });
      }
      const rename = fs.renameSync;
      let calls = 0;
      const spy =
        state === "rename-failure"
          ? vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
              if (++calls === 2) {
                throw new Error("forced corrupt recovery rename failure");
              }
              rename(source, destination);
            })
          : undefined;
      let report;
      try {
        report = await recover();
      } finally {
        spy?.mockRestore();
      }
      if (state === "rename-failure") {
        expect(report.totals.issues).toBe(1);
        expect(report.targets[0]?.corruptRecovery).toBeUndefined();
        expect(report.targets[0]?.issues[0]).toMatchObject({
          code: "sqlite_corrupt_recovery_failed",
          message: expect.stringContaining("forced corrupt recovery rename failure"),
        });
        for (const [file, contents] of files) {
          expect(fs.readFileSync(file, "utf8")).toBe(contents);
        }
        expect(
          fs.readdirSync(path.dirname(sqlitePath)).filter((entry) => entry.includes(".corrupt-")),
        ).toEqual([]);
      } else {
        expect(report.totals.issues).toBe(0);
        expect(report.targets[0]?.corruptRecovery?.movedFiles).toHaveLength(files.size);
        expect(report.targets[0]?.corruptRecovery?.skippedFiles).toEqual(
          state === "orphaned" ? [sqlitePath, `${sqlitePath}-shm`] : [],
        );
        for (const file of files.keys()) {
          expect(fs.existsSync(file)).toBe(false);
          expect(
            report.targets[0]?.corruptRecovery?.movedFiles.some((moved) =>
              moved.startsWith(`${file}.corrupt-`),
            ),
          ).toBe(true);
        }
      }
    },
  );

  it.each(["directory", "maintenance", "inspection"] as const)(
    "preserves recovery state when inspection fails (%s)",
    async (failure) => {
      const { sqlitePath, recover } = createRecoveryStore();
      if (failure === "directory") {
        fs.mkdirSync(sqlitePath, { recursive: true });
      } else {
        fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });
      }
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const spy =
        failure === "directory"
          ? undefined
          : vi
              .spyOn(nodeSqlite, "openNodeSqliteDatabase")
              .mockImplementation((pathname, options) => {
                if (
                  failure === "maintenance" ||
                  path.basename(pathname) === path.basename(sqlitePath)
                ) {
                  throw new Error("node:sqlite unavailable");
                }
                return openDatabase(pathname, options);
              });
      try {
        const recovery = recover();
        if (failure === "maintenance") {
          await expect(recovery).rejects.toThrow(
            "failed to acquire agent database maintenance lease",
          );
          expect(fs.readFileSync(sqlitePath, "utf8")).toBe("not a sqlite database\n");
          return;
        }
        const report = await recovery;
        expect(report.totals.issues).toBe(1);
        expect(report.targets[0]?.corruptRecovery).toBeUndefined();
        expect(report.targets[0]?.issues[0]?.code).toBe("sqlite_recovery_inspect_failed");
        if (failure === "directory") {
          expect(fs.statSync(sqlitePath).isDirectory()).toBe(true);
        } else {
          expect(report.targets[0]?.issues[0]?.message).toContain("node:sqlite unavailable");
          expect(fs.existsSync(sqlitePath)).toBe(true);
        }
      } finally {
        spy?.mockRestore();
      }
    },
  );

  it("does not truncate existing SQLite transcript rows when re-importing a duplicate fragment", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        '{"type":"session","sessionId":"session-1"}',
        '{"type":"message","id":"msg-1","message":{"role":"user","content":"first"}}',
        '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}',
      ],
    });

    await importLegacyStore(store);
    fs.writeFileSync(
      store.transcriptPath,
      '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(store.trajectoryPath, `${JSON.stringify({ type: "trajectory" })}\n`, {
      mode: 0o600,
    });

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({
      archivedTranscriptFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: 0,
    });
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(3);
  });

  it.each([false, true])(
    "reports malformed transcripts while importing the session entry (existing prefix: %s)",
    async (existingPrefix) => {
      const store = createLegacyStore({
        agentDirName: "token=supersecret",
        transcriptLines: ['{"type":"session","sessionId":"session-1"}', "{bad"],
      });
      if (!existingPrefix) {
        fs.truncateSync(store.transcriptPath, fs.statSync(store.transcriptPath).size - 1);
      }
      const original = fs.readFileSync(store.transcriptPath);
      if (existingPrefix) {
        await importSqliteSessionRows({
          agentId: "token-supersecret",
          env: store.env,
          sessionKey: "agent:main:main",
          storePath: store.storePath,
          entry: { sessionId: "session-1", updatedAt: 2000 },
          readTranscriptEvents: createTranscriptEventReader(
            store.transcriptPath,
            "session-1",
            true,
          ),
        });
      }

      const report = await importLegacyStore(store);
      const inspect = await runDoctorSessionSqlite({
        env: store.env,
        mode: "inspect",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(1);
      expect(report.totals).toMatchObject({
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedEntries: 1,
        importedTranscriptEvents: existingPrefix ? 0 : 1,
        sqliteEntries: 1,
        unreferencedJsonlFiles: 0,
      });
      expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
      expect(report.targets[0]?.issues.every(isSessionSqliteMigrationWarning)).toBe(true);
      expect(fs.existsSync(store.transcriptPath)).toBe(false);
      expect(fs.existsSync(store.unreferencedJsonlPath)).toBe(false);
      expect(inspect.totals.sqliteEntries).toBe(1);
      expect(
        loadTranscriptEventsSync({
          agentId: "token-supersecret",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          storePath: store.storePath,
        }),
      ).toHaveLength(1);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      const transcriptMove = expectDefined(
        manifest.targets[0]?.completedMoves.find((move) => move.kind === "transcript"),
        "protected malformed transcript archive",
      );
      expect(transcriptMove.artifact?.classification).toBe("protected");
      expect(fs.readFileSync(transcriptMove.archivePath)).toEqual(original);
      expect(
        manifest.targets[0]?.completedMoves.some((move) => move.kind === "unreferenced-jsonl"),
      ).toBe(true);
      expect(manifest.failedAt).toBeUndefined();
      expect(manifest.failureReports).toBeUndefined();
      expect(report.migrationRun?.failureReportMarkdownPath).toBeUndefined();
      expect(() =>
        assertSessionStoreMigrationComplete({ cfg: {}, env: store.env, operation: "doctor" }),
      ).not.toThrow();
    },
  );

  it("reports malformed selected legacy transcripts during validation", async () => {
    const store = createLegacyStore({ transcriptLines: ['{"type":"session"}', "{bad"] });
    await upsertSessionEntryCore(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      { sessionId: "session-1", updatedAt: 2000 },
    );

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "validate",
      store: store.storePath,
    });

    expect(report.totals).toMatchObject({
      issues: 2,
      sqliteEntries: 1,
      validatedEntries: 1,
      validatedTranscriptEvents: 0,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "transcript_malformed",
      sessionKey: "agent:main:main",
    });
  });
});

function createRecoveryStore() {
  const store = createLegacyStore();
  const sqlitePath = path.join(store.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  return {
    sqlitePath,
    recover: () =>
      runDoctorSessionSqlite({ env: store.env, mode: "recover", store: store.storePath }),
  };
}
