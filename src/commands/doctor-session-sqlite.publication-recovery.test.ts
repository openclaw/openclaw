import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as directoryDurability from "../infra/directory-durability.js";
import * as migrationArtifact from "../infra/session-sqlite-migration-artifact.js";
import * as sqliteReaders from "../infra/session-sqlite-migration-readers.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  RECOVERY_TRANSCRIPT_LINES,
  runPublicSessionSqlite,
  importLegacyStore,
  useDoctorSessionSqliteTestFixture,
  readMigrationManifest,
  requireMigrationManifestPath,
  canonicalTestPath,
} from "./doctor-session-sqlite.test-support.js";

const {
  createLegacyStore,
  createImportedStoreForCompaction,
  createHistoricalRestoreStore,
  createVerifiedRecoveryStore,
} = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it("preserves shared database bytes without creating a WAL when custom restore refuses disposed sources", async () => {
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
    const readArtifacts = () =>
      [shared, `${shared}-wal`].map((file) =>
        fs.existsSync(file) ? fs.readFileSync(file) : undefined,
      );
    const before = readArtifacts();
    expect(before[0]?.length).toBeGreaterThan(0);
    expect(before[1]).toBeUndefined();
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
  });

  it("explains hard-linked index refusal without changing either link", async () => {
    const store = createLegacyStore();
    const sourcePath = store.storePath;
    const snapshotPath = path.join(store.tempDir, "snapshot");
    const originalBytes = fs.readFileSync(sourcePath);
    fs.linkSync(sourcePath, snapshotPath);
    const diagnostics = [
      sourcePath,
      "nlink=2",
      "another hard link references this inode",
      "backup",
      "#hard-linked-legacy-artifacts",
    ];
    {
      const refused = importLegacyStore(store);
      for (const message of diagnostics) {
        await expect(refused).rejects.toThrow(message);
      }
    }
    expect(fs.lstatSync(sourcePath).nlink).toBe(2);
    expect(fs.readFileSync(sourcePath)).toEqual(originalBytes);
    expect(fs.readFileSync(snapshotPath)).toEqual(originalBytes);
    expect(fs.existsSync(store.storePath)).toBe(true);
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    {
      const copyPath = path.join(store.sessionDir, "sessions-copy.tmp");
      fs.copyFileSync(store.storePath, copyPath, fs.constants.COPYFILE_EXCL);
      expect(fs.readFileSync(copyPath)).toEqual(originalBytes);
      fs.renameSync(copyPath, store.storePath);
      expect(fs.lstatSync(store.storePath).nlink).toBe(1);
      expect((await importLegacyStore(store)).totals.issues).toBe(0);
      expect(fs.readFileSync(snapshotPath)).toEqual(originalBytes);
    }
  });

  it.skipIf(process.platform === "win32").each(["archive", "database"] as const)(
    "rejects a symlink-backed %s before maintenance",
    async (kind) => {
      const imported = kind === "database" ? await createImportedStoreForCompaction() : undefined;
      const store = imported?.store ?? createLegacyStore();
      const sourcePath =
        imported?.sqlitePath ??
        path.join(path.dirname(store.sessionDir), "session-sqlite-import-archive");
      const realPath = path.join(store.tempDir, "symlink-target");
      if (kind === "archive") {
        fs.mkdirSync(realPath);
      } else {
        fs.renameSync(sourcePath, realPath);
      }
      fs.symlinkSync(realPath, sourcePath);
      await expect(
        runDoctorSessionSqlite({
          env: store.env,
          store: store.storePath,
          mode: kind === "database" ? "compact" : "import",
        }),
      ).rejects.toThrow(
        kind === "database"
          ? /Cannot run session SQLite compact.*symbolic-link path/iu
          : "Refusing session SQLite migration through symbolic link",
      );
      expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(realPath)).toBe(true);
      if (kind !== "database") {
        expect(fs.existsSync(store.transcriptPath)).toBe(true);
        if (kind === "archive") {
          expect(fs.existsSync(store.storePath)).toBe(true);
          expect(fs.readdirSync(realPath)).toEqual([]);
        }
      }
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

describe("runDoctorSessionSqlite", () => {
  it.each([
    { kind: "transcript", mode: "import" },
    { kind: "legacy-store", mode: "restore" },
  ] as const)(
    "recovers interrupted $kind publication through public $mode",
    async ({ kind, mode }) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
      const source = kind === "transcript" ? store.transcriptPath : store.storePath;
      const original = fs.readFileSync(source);
      const token = "sk-abcdefghijklmnopqrstuv";
      const unlink = fs.unlinkSync;
      let injected = false;
      const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (!injected && file === source) {
          injected = true;
          throw new Error(
            `injected interruption before source unlink: Authorization: Bearer ${token}`,
          );
        }
        return unlink(file);
      });
      let interrupted;
      try {
        interrupted = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      const manifestPath = requireMigrationManifestPath(interrupted.migrationRun?.manifestPath);
      const move = readMigrationManifest(manifestPath).targets[0]!.plannedMoves.find(
        (item) => item.sourcePath === source,
      )!;
      const issueCode =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      const issue = interrupted.targets[0]?.issues.find((item) => item.code === issueCode);
      expect(issue?.message).toContain("injected interruption before source unlink");
      expect(issue?.message).not.toContain(token);
      expect(fs.readFileSync(source)).toEqual(original);
      expect(fs.statSync(source).nlink).toBe(2);
      expect(fs.statSync(source).ino).toBe(fs.statSync(move.archivePath).ino);
      const recovered = await runPublicSessionSqlite(store, mode);
      expect(recovered.exitCode).toBe(0);
      expect(recovered.report.targets[0]?.issues).toEqual([]);
      expect(readMigrationManifest(manifestPath).restore?.consumedArchives).toContain(
        move.archivePath,
      );
      expect(fs.existsSync(move.archivePath)).toBe(false);
      if (mode === "restore") {
        expect(fs.statSync(source).nlink).toBe(1);
        expect(fs.readFileSync(source)).toEqual(original);
        const reimport = await importLegacyStore(store);
        expect(reimport.targets[0]?.issues).toEqual([]);
      }
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.status).toBe("complete");
      expect(cleanup.totals.removedFiles).toBe(2);
    },
  );

  it.each(["mismatch", "third-link"] as const)(
    "refuses public recovery of a recorded publication with %s",
    async (fault) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
      const move = manifest.targets[0]!.plannedMoves.find((item) => item.kind === "legacy-store")!;
      fs.linkSync(move.archivePath, move.sourcePath);
      const third = path.join(store.sessionDir, "unexpected-alias");
      if (fault === "third-link") {
        fs.linkSync(move.sourcePath, third);
      } else {
        fs.writeFileSync(move.sourcePath, "different bytes on the same inode");
      }
      const before = fs.readFileSync(move.sourcePath);
      for (const mode of ["import", "restore"] as const) {
        await expect(runPublicSessionSqlite(store, mode)).rejects.toThrow(
          /hard-linked|archive identity or contents changed/,
        );
        expect(fs.readFileSync(move.sourcePath)).toEqual(before);
        expect(fs.readFileSync(move.archivePath)).toEqual(before);
        expect(fs.statSync(move.sourcePath).nlink).toBe(fault === "third-link" ? 3 : 2);
      }
    },
  );

  it.each([2] as const)(
    "protects historical v%s restore metadata and its retained transcript dependency from cleanup",
    async (version) => {
      const { store, manifestPath, manifest, archivePath } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical cleanup target");
      const index = expectDefined(
        target.plannedMoves.find((move) => move.kind === "legacy-store"),
        "historical index",
      );
      const indexIdentity = migrationArtifact.readMigrationArtifactIdentity(index.archivePath);
      const indexBytes = fs.readFileSync(index.archivePath);
      const transcriptBytes = fs.readFileSync(archivePath);
      fs.writeFileSync(store.transcriptPath, "new source history\n", { mode: 0o600 });
      const publish = directoryDurability.publishFileExclusive;
      const publicationSpy = vi
        .spyOn(directoryDurability, "publishFileExclusive")
        .mockImplementation(async (options) => {
          if (options.sourcePath === index.archivePath && options.targetPath === index.sourcePath) {
            throw Object.assign(new Error("injected unsupported hard link"), { code: "EXDEV" });
          }
          return publish(options);
        });
      const copySpy = vi.spyOn(fs, "copyFileSync");
      const asyncCopySpy = vi.spyOn(fsPromises, "copyFile");
      try {
        const failed = await runPublicSessionSqlite(store, "restore");
        expect(failed.exitCode).toBe(1);
        expect(failed.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining([expect.objectContaining({ archivePath: index.archivePath })]),
        );
        expect(publicationSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sourcePath: index.archivePath,
            targetPath: index.sourcePath,
            strategy: "link-required",
          }),
        );
        expect(copySpy).not.toHaveBeenCalled();
        expect(asyncCopySpy).not.toHaveBeenCalled();
      } finally {
        publicationSpy.mockRestore();
        copySpy.mockRestore();
        asyncCopySpy.mockRestore();
      }
      const recorded = readMigrationManifest(manifestPath);
      expect(recorded.manifestVersion).toBe(version);
      const indexMoves = [
        ...recorded.targets[0]!.plannedMoves,
        ...recorded.targets[0]!.completedMoves,
      ].filter((move) => move.archivePath === index.archivePath);
      expect(indexMoves).toHaveLength(2);
      for (const move of indexMoves) {
        expect(move.artifact).toMatchObject({
          classification: "protected",
          disposal: { state: "retained" },
          identity: indexIdentity,
          dependencies: [canonicalTestPath(store.transcriptPath)],
        });
      }
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((item) => item.path === index.archivePath)?.outcome).toBe(
        "protected",
      );
      expect(preview.artifacts.find((item) => item.path === archivePath)).toMatchObject({
        outcome: "protected",
        reason: "retained-recovery-dependency",
      });
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.totals.removedFiles).toBe(0);
      expect(fs.readFileSync(index.archivePath)).toEqual(indexBytes);
      expect(fs.readFileSync(archivePath)).toEqual(transcriptBytes);
      expect(fs.readFileSync(store.transcriptPath, "utf8")).toBe("new source history\n");
      expect(fs.existsSync(index.sourcePath)).toBe(false);
      expect(fs.existsSync(target.sqlitePath)).toBe(false);
    },
  );
});
