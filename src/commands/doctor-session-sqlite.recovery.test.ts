import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore as upsertEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync as readEvents } from "../config/sessions/session-accessor.sqlite-read.js";
import { assertSessionStoreMigrationComplete as assertMigrated } from "../config/sessions/startup-migration.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { isSessionSqliteMigrationWarning } from "../infra/session-sqlite-migration-issues.js";
import { createTranscriptEventReader } from "../infra/session-sqlite-migration-readers.js";
import {
  messageEvent,
  writePrivateFile,
  runStoreDoctor,
  sessionScope,
  archivedSource,
  migrationManifest,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  expectMissing,
  expectFiles,
  containsObjects,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  importLegacyStore,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();
const header = { type: "session", version: 3, id: "session-1", cwd: "/fixture", timestamp: "" };

describe("runDoctorSessionSqlite", () => {
  it.each(["fresh", "prefix", "complete", "unindexed"] as const)(
    "archives redundant session headers after a %s import",
    async (state) => {
      const lines = [
        header,
        messageEvent("one", "user", "first"),
        { ...header, timestamp: "2026-09-01T00:00:00Z" },
        messageEvent("two", "assistant", "second", "one"),
      ].map((event) => JSON.stringify(event));
      const store = createLegacyStore({ transcriptLines: lines });
      const original = fs.readFileSync(store.transcriptPath);
      if (state === "unindexed") {
        fs.writeFileSync(store.storePath, "{}\n");
      }
      const scope = {
        ...sessionScope(store),
        sessionKey: state === "unindexed" ? "agent:main:recovered:session-1" : "agent:main:main",
      };
      if (state === "prefix" || state === "complete") {
        const prefix = path.join(store.tempDir, "prefix.jsonl");
        fs.writeFileSync(
          prefix,
          `${(state === "prefix" ? lines.slice(0, 2) : lines).join("\n")}\n`,
        );
        await importSqliteSessionRows({
          ...scope,
          entry: { sessionId: "session-1", updatedAt: 2000 },
          readTranscriptEvents: createTranscriptEventReader(prefix, "session-1"),
        });
        const validation = await runStoreDoctor(store, "validate");
        expect(
          validation.targets[0]?.issues.some(
            (issue) => issue.code === "sqlite_transcript_count_mismatch",
          ),
        ).toBe(state === "prefix");
      }

      const report = await importLegacyStore(store);
      expect(report.targets[0]?.issues).toEqual([]);
      expect(report.totals.archivedTranscriptFiles).toBe(2);
      const manifest = migrationManifest(report);
      expect(manifest.targets[0]?.validationBeforeArchive).toBe("passed");
      expectFiles(original, archivedSource(report, store.transcriptPath).archivePath);
      expect(archivedSource(report, store.storePath).kind).toBe("legacy-store");
      expectMissing(store.storePath, store.transcriptPath);
      expect(readEvents(scope)).toMatchObject([header, { id: "one" }, { id: "two" }]);
      expect(() => assertMigrated({ cfg: {}, env: store.env, operation: "doctor" })).not.toThrow();
    },
  );

  it.each([false, true])(
    "retains a conflicting same-id session header (unindexed=%s)",
    async (unindexed) => {
      const store = createLegacyStore({
        transcriptLines: [
          JSON.stringify(header),
          JSON.stringify(messageEvent("one", "user", "first")),
          JSON.stringify({ ...header, cwd: "/other" }),
        ],
      });
      if (unindexed) {
        fs.writeFileSync(store.storePath, "{}\n");
      }
      const original = fs.readFileSync(store.transcriptPath);
      const report = await importLegacyStore(store);
      containsObjects(report.targets[0]?.issues, {
        code: unindexed ? "historical_transcript_deferred" : "sqlite_transcript_count_mismatch",
      });
      let retainedTranscriptPath = store.transcriptPath;
      if (unindexed) {
        const archive = archivedSource(report, store.transcriptPath);
        expect(archive.artifact?.classification).toBe("protected");
        retainedTranscriptPath = archive.archivePath;
      } else {
        expect(migrationManifest(report).targets[0]?.validationBeforeArchive).toBe("failed");
        expect(report.totals.archivedLegacyStoreFiles).toBe(0);
        expect(fs.existsSync(store.storePath)).toBe(true);
      }
      expectFiles(original, retainedTranscriptPath);
    },
  );

  it.each(["orphaned", "rename-failure"] as const)(
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
        writePrivateFile(file, contents);
      }
      const rename = fs.renameSync;
      let calls = 0;
      using spy =
        state === "rename-failure"
          ? vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
              if (++calls === 2) {
                throw new Error("forced corrupt recovery rename failure");
              }
              rename(source, destination);
            })
          : undefined;
      const report = await recover();
      spy?.mockRestore();
      if (state === "rename-failure") {
        expect(report.totals.issues).toBe(1);
        expect(report.targets[0]?.corruptRecovery).toBeUndefined();
        expect(report.targets[0]?.issues[0]).toMatchObject({
          code: "sqlite_corrupt_recovery_failed",
          message: expect.stringContaining("forced corrupt recovery rename failure"),
        });
        for (const [file, contents] of files) {
          expectFiles(contents, file);
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
          expectMissing(file);
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
        writePrivateFile(sqlitePath, "not a sqlite database\n");
      }
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      using spy =
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
      const recovery = recover();
      if (failure === "maintenance") {
        await expect(recovery).rejects.toThrow(
          "failed to acquire agent database maintenance lease",
        );
        expect(fs.readFileSync(sqlitePath, "utf8")).toBe("not a sqlite database\n");
        return;
      }
      const report = await recovery;
      spy?.mockRestore();
      expect(report.totals.issues).toBe(1);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
      expect(report.targets[0]?.issues[0]?.code).toBe("sqlite_recovery_inspect_failed");
      if (failure === "directory") {
        expect(fs.statSync(sqlitePath).isDirectory()).toBe(true);
      } else {
        expect(report.targets[0]?.issues[0]?.message).toContain("node:sqlite unavailable");
        expect(fs.existsSync(sqlitePath)).toBe(true);
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
    writePrivateFile(
      store.transcriptPath,
      '{"type":"message","id":"msg-2","message":{"role":"assistant","content":"second"}}\n',
    );
    writePrivateFile(store.trajectoryPath, `${JSON.stringify({ type: "trajectory" })}\n`);

    const report = await importLegacyStore(store);

    expect(report.totals.issues).toBe(0);
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(readEvents(sessionScope(store))).toHaveLength(3);
  });

  it("reports malformed transcripts while importing an entry with an existing prefix", async () => {
    const store = createLegacyStore({
      agentDirName: "token=supersecret",
      transcriptLines: ['{"type":"session","sessionId":"session-1"}', "{bad"],
    });
    const original = fs.readFileSync(store.transcriptPath);

    await importSqliteSessionRows({
      ...sessionScope(store, "token-supersecret"),
      entry: { sessionId: "session-1", updatedAt: 2000 },
      readTranscriptEvents: createTranscriptEventReader(store.transcriptPath, "session-1", true),
    });

    const report = await importLegacyStore(store);
    const inspect = await runStoreDoctor(store, "inspect");
    expect(report.totals.issues).toBe(1);
    expect(report.targets[0]?.issues[0]?.code).toBe("transcript_malformed");
    expect(report.targets[0]?.issues.every(isSessionSqliteMigrationWarning)).toBe(true);
    expectMissing(store.transcriptPath, store.unreferencedJsonlPath);
    expect(inspect.totals.sqliteEntries).toBe(1);
    expect(readEvents(sessionScope(store, "token-supersecret"))).toHaveLength(1);
    const manifest = migrationManifest(report);
    const transcriptMove = archivedSource(report, store.transcriptPath);
    expect(transcriptMove.artifact?.classification).toBe("protected");
    expectFiles(original, transcriptMove.archivePath);
    expect(
      manifest.targets[0]?.completedMoves.some((move) => move.kind === "unreferenced-jsonl"),
    ).toBe(true);
    expect(manifest.failedAt).toBeUndefined();
    expect(manifest.failureReports).toBeUndefined();
    expect(report.migrationRun?.failureReportMarkdownPath).toBeUndefined();
    expect(() => assertMigrated({ cfg: {}, env: store.env, operation: "doctor" })).not.toThrow();
  });

  it("reports malformed selected legacy transcripts during validation", async () => {
    const store = createLegacyStore({ transcriptLines: ['{"type":"session"}', "{bad"] });
    await upsertEntry(sessionScope(store), { sessionId: "session-1", updatedAt: 2000 });

    const report = await runStoreDoctor(store, "validate");

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
    recover: () => runStoreDoctor(store, "recover"),
  };
}
