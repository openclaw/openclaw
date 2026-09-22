import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as sqliteReaders from "./doctor-session-sqlite-readers.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import {
  RECOVERY_TRANSCRIPT_LINES,
  runPublicSessionSqlite,
  importLegacyStore,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each(["absent", "populated"] as const)(
    "preserves shared database bytes with WAL %s when custom restore refuses disposed sources",
    async (wal) => {
      const store = createLegacyStore({
        customStore: true,
        transcriptLines: RECOVERY_TRANSCRIPT_LINES,
      });
      fs.unlinkSync(store.trajectoryPath);
      fs.unlinkSync(store.unreferencedJsonlPath);
      store.stateDir = store.tempDir;
      store.env.OPENCLAW_STATE_DIR = store.stateDir;
      process.env.OPENCLAW_STATE_DIR = store.stateDir;
      const cfg = { session: { store: store.storePath } };
      const imported = await runPublicSessionSqlite(store, "import");
      expect(imported.exitCode).toBe(0);
      expect(imported.report.totals.importedEntries).toBe(1);
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg, env: store.env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(cleanup.status).toBe("complete");
      expect(cleanup.totals.removedFiles).toBe(2);
      closeOpenClawStateDatabaseForTest();
      // A new CLI process has neither a live connection nor a warm registry memo.
      invalidateRegisteredAgentDatabasesMemo({ env: store.env });
      const shared = resolveOpenClawStateSqlitePath(store.env);
      const writer = wal === "populated" ? nodeSqlite.openNodeSqliteDatabase(shared) : undefined;
      try {
        writer?.exec(
          "PRAGMA wal_autocheckpoint = 0; UPDATE schema_meta SET updated_at = updated_at + 1",
        );
        const readArtifacts = () =>
          [shared, `${shared}-wal`].map((file) =>
            fs.existsSync(file) ? fs.readFileSync(file) : undefined,
          );
        const before = readArtifacts();
        expect(before[0]?.length).toBeGreaterThan(0);
        if (wal === "absent") {
          expect(before[1]).toBeUndefined();
        } else {
          expect(before[1]?.length).toBeGreaterThan(32);
        }
        const restored = await runPublicSessionSqlite(store, "restore");
        expect(restored.exitCode).toBe(1);
        expect(restored.report.targets[0]?.restore?.restoredFiles).toEqual([]);
        expect(restored.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ reason: expect.stringContaining("intentionally disposed") }),
          ]),
        );
        expect(readArtifacts()).toEqual(before);
        expect(fs.existsSync(store.storePath)).toBe(false);
        expect(fs.existsSync(store.transcriptPath)).toBe(false);
      } finally {
        writer?.close();
      }
    },
  );

  it("explains hard-linked legacy index refusal and supports an independent copy before retry", async () => {
    const store = createLegacyStore();
    const snapshotPath = path.join(store.tempDir, "snapshot-sessions.json");
    const originalBytes = fs.readFileSync(store.storePath);
    fs.linkSync(store.storePath, snapshotPath);

    const refused = importLegacyStore(store);
    await expect(refused).rejects.toThrow(store.storePath);
    await expect(refused).rejects.toThrow("nlink=2");
    await expect(refused).rejects.toThrow("another hard link references this inode");
    await expect(refused).rejects.toThrow("backup");
    await expect(refused).rejects.toThrow("#hard-linked-legacy-artifacts");
    expect(fs.lstatSync(store.storePath).nlink).toBe(2);
    expect(fs.readFileSync(store.storePath)).toEqual(originalBytes);
    expect(fs.readFileSync(snapshotPath)).toEqual(originalBytes);
    expect(fs.existsSync(store.transcriptPath)).toBe(true);

    const copyPath = path.join(store.sessionDir, "sessions-copy.tmp");
    fs.copyFileSync(store.storePath, copyPath, fs.constants.COPYFILE_EXCL);
    expect(fs.readFileSync(copyPath)).toEqual(originalBytes);
    fs.renameSync(copyPath, store.storePath);
    expect(fs.lstatSync(store.storePath).nlink).toBe(1);
    expect((await importLegacyStore(store)).totals.issues).toBe(0);
    expect(fs.readFileSync(snapshotPath)).toEqual(originalBytes);
  });

  it("explains hard-linked transcript archive refusal without changing either link", async () => {
    const store = createLegacyStore();
    const snapshotPath = path.join(store.tempDir, "snapshot-transcript.jsonl");
    const originalBytes = fs.readFileSync(store.transcriptPath);
    fs.linkSync(store.transcriptPath, snapshotPath);

    const report = await importLegacyStore(store);
    const issue = expectDefined(
      report.targets[0]?.issues.find((entry) => entry.code === "transcript_archive_failed"),
      "hard-linked transcript archive refusal",
    );
    expect(issue.message).toContain(store.transcriptPath);
    expect(issue.message).toContain("nlink=2");
    expect(issue.message).toContain("another hard link references this inode");
    expect(issue.message).toContain("backup");
    expect(issue.message).toContain("#hard-linked-legacy-artifacts");
    expect(fs.lstatSync(store.transcriptPath).nlink).toBe(2);
    expect(fs.readFileSync(store.transcriptPath)).toEqual(originalBytes);
    expect(fs.readFileSync(snapshotPath)).toEqual(originalBytes);
    expect(fs.existsSync(store.storePath)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlink-backed legacy stores before migration",
    async () => {
      const store = createLegacyStore();
      const realStorePath = path.join(store.tempDir, "real-sessions.json");
      fs.renameSync(store.storePath, realStorePath);
      fs.symlinkSync(realStorePath, store.storePath);

      await expect(importLegacyStore(store)).rejects.toThrow(
        "Refusing session SQLite migration through symbolic link",
      );

      expect(fs.lstatSync(store.storePath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(realStorePath)).toBe(true);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlink-backed archive directories before migration",
    async () => {
      const store = createLegacyStore();
      const archiveDir = path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
      const outsideArchiveDir = path.join(store.tempDir, "outside-archive");
      fs.mkdirSync(outsideArchiveDir, { recursive: true });
      fs.symlinkSync(outsideArchiveDir, archiveDir);

      await expect(importLegacyStore(store)).rejects.toThrow(
        "Refusing session SQLite migration through symbolic link",
      );

      expect(fs.existsSync(store.storePath)).toBe(true);
      expect(fs.existsSync(store.transcriptPath)).toBe(true);
      expect(fs.readdirSync(outsideArchiveDir)).toEqual([]);
    },
  );

  it.each([false, true])(
    "imports aliases before archival and retains a failed alias (failed=%s)",
    async (failed) => {
      const store = createLegacyStore({
        transcriptLines: [
          '{"type":"session","sessionId":"session-1"}',
          '{"type":"message","message":{"role":"user","content":"shared legacy message"}}',
        ],
      });
      const legacyStore = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
        string,
        unknown
      >;
      legacyStore["agent:main:alias"] = legacyStore["agent:main:main"];
      fs.writeFileSync(store.storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, {
        mode: 0o600,
      });

      const original = fs.readFileSync(store.transcriptPath);
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            failed &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has("agent:main:alias")
          ) {
            const keys = new Map(result.snapshot.sessionIdsBySessionKey);
            keys.delete("agent:main:alias");
            return { ok: true, snapshot: { ...result.snapshot, sessionIdsBySessionKey: keys } };
          }
          return result;
        });
      let report;
      try {
        report = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      if (failed) {
        expect(report.targets[0]?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "sqlite_entry_missing",
              sessionKey: "agent:main:alias",
            }),
          ]),
        );
        expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
      } else {
        expect(report.targets[0]?.issues).toEqual([]);
      }

      expect(report.totals).toMatchObject({
        archivedTranscriptFiles: failed ? 0 : 2,
        importedEntries: 2,
        importedTranscriptEvents: 2,
        sqliteEntries: 2,
      });
      expect(fs.existsSync(store.transcriptPath)).toBe(failed);
      expect(
        loadExactSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: store.storePath,
        })?.entry.sessionId,
      ).toBe("session-1");
      expect(
        loadExactSessionEntry({
          agentId: "main",
          sessionKey: "agent:main:alias",
          storePath: store.storePath,
        })?.entry.sessionId,
      ).toBe("session-1");
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.totals.removedFiles).toBe(failed ? 0 : 2);
      if (failed) {
        expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
      }
    },
  );

  it("leaves legacy transcript symlinks in place instead of archiving them", async () => {
    const store = createLegacyStore();
    const outsideTranscriptPath = path.join(store.tempDir, "outside-session-1.jsonl");
    fs.renameSync(store.transcriptPath, outsideTranscriptPath);
    fs.symlinkSync(outsideTranscriptPath, store.transcriptPath);

    const report = await importLegacyStore(store);

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/archive_failed$/),
        }),
      ]),
    );
    expect(report.targets[0]?.archivedTranscriptFiles).toEqual([]);
    expect(fs.existsSync(outsideTranscriptPath)).toBe(true);
    expect(fs.lstatSync(store.transcriptPath).isSymbolicLink()).toBe(true);
  });
});
