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
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it("moves corrupt SQLite database files aside during recovery", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-wal`, "wal", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-shm`, "shm", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-journal`, "journal", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(report.targets[0]?.corruptRecovery?.movedFiles).toHaveLength(4);
    expect(report.targets[0]?.corruptRecovery?.skippedFiles).toEqual([]);
    for (const candidate of resolveSqliteDatabaseFilePaths(sqlitePath)) {
      expect(fs.existsSync(candidate)).toBe(false);
      expect(
        report.targets[0]?.corruptRecovery?.movedFiles.some((filePath) =>
          filePath.startsWith(`${candidate}.corrupt-`),
        ),
      ).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")(
    "recovers owner-readable corrupt SQLite database files",
    async () => {
      const store = createLegacyStore();
      const sqlitePath = path.join(
        store.stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
      fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o400 });

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "recover",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(report.targets[0]?.corruptRecovery?.movedFiles).toEqual([
        expect.stringMatching(/openclaw-agent\.sqlite\.corrupt-/u),
      ]);
      expect(fs.existsSync(sqlitePath)).toBe(false);
    },
  );

  it("moves orphaned SQLite sidecars aside during recovery", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(`${sqlitePath}-wal`, "wal", { mode: 0o600 });
    fs.writeFileSync(`${sqlitePath}-journal`, "journal", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(0);
    expect(report.targets[0]?.corruptRecovery?.movedFiles).toHaveLength(2);
    expect(report.targets[0]?.corruptRecovery?.skippedFiles).toEqual([
      sqlitePath,
      `${sqlitePath}-shm`,
    ]);
    expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}-journal`)).toBe(false);
  });

  it("rolls back every completed corrupt-file move when a later rename fails", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const expectedContents = new Map<string, string>();
    for (const [candidate, contents] of [
      [sqlitePath, "not a sqlite database\n"],
      [`${sqlitePath}-wal`, "wal"],
      [`${sqlitePath}-shm`, "shm"],
      [`${sqlitePath}-journal`, "journal"],
    ] as const) {
      fs.writeFileSync(candidate, contents, { mode: 0o600 });
      expectedContents.set(candidate, contents);
    }
    const renameSync = fs.renameSync.bind(fs);
    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      renameCalls += 1;
      if (renameCalls === 2) {
        throw new Error("forced corrupt recovery rename failure");
      }
      renameSync(source, destination);
    });

    let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>> | undefined;
    try {
      report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "recover",
        store: store.storePath,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(report?.totals.issues).toBe(1);
    expect(report?.targets[0]?.corruptRecovery).toBeUndefined();
    expect(report?.targets[0]?.issues[0]).toMatchObject({
      code: "sqlite_corrupt_recovery_failed",
      message: expect.stringContaining("forced corrupt recovery rename failure"),
    });
    for (const [candidate, contents] of expectedContents) {
      expect(fs.readFileSync(candidate, "utf8")).toBe(contents);
    }
    expect(
      fs.readdirSync(path.dirname(sqlitePath)).filter((entry) => entry.includes(".corrupt-")),
    ).toEqual([]);
  });

  it("does not move SQLite paths aside for non-corruption recovery inspection failures", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(sqlitePath, { recursive: true });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(1);
    expect(report.targets[0]?.issues[0]?.code).toBe("sqlite_recovery_inspect_failed");
    expect(report.targets[0]?.corruptRecovery).toBeUndefined();
    expect(fs.statSync(sqlitePath).isDirectory()).toBe(true);
  });

  it.each(["maintenance", "inspection"])(
    "preserves recovery state when the %s SQLite loader fails",
    async (failure) => {
      const store = createLegacyStore();
      const sqlitePath = path.join(
        store.stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
      fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const openSqlite = vi
        .spyOn(nodeSqlite, "openNodeSqliteDatabase")
        .mockImplementation((pathname, options) => {
          // An unavailable lease store must refuse; an unreadable agent copy is reportable.
          if (failure === "maintenance" || path.basename(pathname) === path.basename(sqlitePath)) {
            throw new Error("node:sqlite unavailable");
          }
          return openDatabase(pathname, options);
        });

      let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>> | undefined;
      try {
        const recovery = runDoctorSessionSqlite({
          env: store.env,
          mode: "recover",
          store: store.storePath,
        });
        if (failure === "maintenance") {
          await expect(recovery).rejects.toThrow(
            "failed to acquire agent database maintenance lease",
          );
          expect(fs.readFileSync(sqlitePath, "utf8")).toBe("not a sqlite database\n");
          return;
        }
        report = await recovery;
      } finally {
        openSqlite.mockRestore();
      }

      expect(report?.totals.issues).toBe(1);
      expect(report?.targets[0]?.issues[0]).toMatchObject({
        code: "sqlite_recovery_inspect_failed",
        message: expect.stringContaining("node:sqlite unavailable"),
      });
      expect(report?.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.existsSync(sqlitePath)).toBe(true);
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

  it("reports custom explicit store sqlite paths beside the store", async () => {
    const store = createLegacyStore({ customStore: true });

    const report = await importLegacyStore(store);

    expect(report.targets[0]?.sqlitePath).toBe(
      path.join(store.sessionDir, "openclaw-agent.sqlite"),
    );
    expect(
      fs.existsSync(
        expectDefined(
          report.targets[0]?.sqlitePath,
          "report.targets[0]?.sqlitePath test invariant",
        ),
      ),
    ).toBe(true);
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(2);
  });

  it("reports a malformed non-newline-terminated final JSONL record", async () => {
    const store = createLegacyStore();
    fs.writeFileSync(
      store.transcriptPath,
      '{"type":"session","sessionId":"session-1"}\n{"type":"message"',
      { mode: 0o600 },
    );

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 1,
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toHaveLength(1);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
  });

  it.each([false, true])(
    "reports malformed transcripts while importing the session entry (existing prefix: %s)",
    async (existingPrefix) => {
      const store = createLegacyStore({
        agentDirName: "token=supersecret",
        transcriptLines: ['{"type":"session","sessionId":"session-1"}', "{bad"],
      });
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
