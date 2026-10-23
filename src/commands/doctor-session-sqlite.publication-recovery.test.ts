import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as durability from "../infra/directory-durability.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import * as readers from "../infra/session-sqlite-migration-readers.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  containsObjects,
  expectFiles,
  expectMissing,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  RECOVERY_TRANSCRIPT_LINES,
  runPublicSessionSqlite as runPublic,
  importLegacyStore,
  useDoctorSessionSqliteTestFixture,
  readMigrationManifest as readManifest,
  requireMigrationManifestPath,
  canonicalTestPath,
  type TestStore,
} from "./doctor-session-sqlite.test-support.js";

const {
  createLegacyStore,
  createImportedStoreForCompaction,
  createHistoricalRestoreStore,
  createVerifiedRecoveryStore,
} = useDoctorSessionSqliteTestFixture();

async function cleanupRecovery(store: TestStore, cfg = {}) {
  closeOpenClawAgentDatabasesForTest();
  return retireSessionSqliteRecovery({
    env: store.env,
    preview: inspectSessionSqliteRecovery({ cfg, env: store.env }),
    readConfig: async () => cfg,
    confirm: async () => true,
  });
}

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
  const imported = await runPublic(store, "import");
  expect(imported).toMatchObject({ exitCode: 0, report: { totals: { importedEntries: 1 } } });
  expect(await cleanupRecovery(store, cfg)).toMatchObject({
    status: "complete",
    totals: { removedFiles: 2 },
  });
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
  const restored = await runPublic(store, "restore");
  expect(restored).toMatchObject({
    exitCode: 1,
    report: { targets: [{ restore: { restoredFiles: [] } }] },
  });
  containsObjects(restored.report.targets[0]?.restore?.conflicts, {
    reason: expect.stringContaining("intentionally disposed"),
  });
  expect(readArtifacts()).toEqual(before);
  expectMissing(store.storePath, store.transcriptPath);
});

it("explains hard-linked index refusal without changing either link", async () => {
  const store = createLegacyStore();
  const sourcePath = store.storePath;
  const snapshotPath = path.join(store.tempDir, "snapshot");
  const originalBytes = fs.readFileSync(sourcePath);
  fs.linkSync(sourcePath, snapshotPath);
  const refused = importLegacyStore(store);
  for (const message of [
    sourcePath,
    "nlink=2",
    "another hard link references this inode",
    "backup",
    "#hard-linked-legacy-artifacts",
  ]) {
    await expect(refused).rejects.toThrow(message);
  }
  expect(fs.lstatSync(sourcePath).nlink).toBe(2);
  expectFiles(originalBytes, sourcePath, snapshotPath);
  expect(fs.existsSync(store.transcriptPath)).toBe(true);
  const copyPath = path.join(store.sessionDir, "sessions-copy.tmp");
  fs.copyFileSync(store.storePath, copyPath, fs.constants.COPYFILE_EXCL);
  expectFiles(originalBytes, copyPath);
  fs.renameSync(copyPath, store.storePath);
  expect(fs.lstatSync(store.storePath).nlink).toBe(1);
  expect((await importLegacyStore(store)).totals.issues).toBe(0);
  expectFiles(originalBytes, snapshotPath);
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
      expect(fs.existsSync(store.storePath)).toBe(true);
      expect(fs.readdirSync(realPath)).toEqual([]);
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
    fs.writeFileSync(store.storePath, JSON.stringify(legacyStore), { mode: 0o600 });

    const original = fs.readFileSync(store.transcriptPath);
    const snapshot = readers.readOnlySqliteValidationSnapshot;
    using spy = vi
      .spyOn(readers, "readOnlySqliteValidationSnapshot")
      .mockImplementation((target) => {
        const result = snapshot(target);
        if (failed && result.ok && result.snapshot.sessionIdsBySessionKey.has("agent:main:alias")) {
          const keys = new Map(result.snapshot.sessionIdsBySessionKey);
          keys.delete("agent:main:alias");
          return { ok: true, snapshot: { ...result.snapshot, sessionIdsBySessionKey: keys } };
        }
        return result;
      });
    const report = await importLegacyStore(store);
    spy.mockRestore();
    if (failed) {
      containsObjects(report.targets[0]?.issues, {
        code: "sqlite_entry_missing",
        sessionKey: "agent:main:alias",
      });
      expectFiles(original, store.transcriptPath);
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
    for (const sessionKey of ["agent:main:main", "agent:main:alias"]) {
      expect(
        loadExactSessionEntry({ agentId: "main", sessionKey, storePath: store.storePath })?.entry
          .sessionId,
      ).toBe("session-1");
    }
    const cleanup = await cleanupRecovery(store);
    expect(cleanup.totals.removedFiles).toBe(failed ? 0 : 2);
    if (failed) {
      expectFiles(original, store.transcriptPath);
    }
  },
);

it("leaves legacy transcript symlinks in place instead of archiving them", async () => {
  const store = createLegacyStore();
  const outsideTranscriptPath = path.join(store.tempDir, "outside-session-1.jsonl");
  fs.renameSync(store.transcriptPath, outsideTranscriptPath);
  fs.symlinkSync(outsideTranscriptPath, store.transcriptPath);

  const report = await importLegacyStore(store);

  containsObjects(report.targets[0]?.issues, { code: expect.stringMatching(/archive_failed$/) });
  expect(report.targets[0]?.archivedTranscriptFiles).toEqual([]);
  expect(fs.existsSync(outsideTranscriptPath)).toBe(true);
  expect(fs.lstatSync(store.transcriptPath).isSymbolicLink()).toBe(true);
});
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
    using spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (!injected && file === source) {
        injected = true;
        throw new Error(
          `injected interruption before source unlink: Authorization: Bearer ${token}`,
        );
      }
      return unlink(file);
    });
    const interrupted = await importLegacyStore(store);
    spy.mockRestore();
    expect(injected).toBe(true);
    const manifestPath = requireMigrationManifestPath(interrupted.migrationRun?.manifestPath);
    const move = readManifest(manifestPath).targets[0]!.plannedMoves.find(
      (item) => item.sourcePath === source,
    )!;
    const issueCode =
      kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
    const issue = interrupted.targets[0]?.issues.find((item) => item.code === issueCode);
    expect(issue?.message).toContain("injected interruption before source unlink");
    expect(issue?.message).not.toContain(token);
    expectFiles(original, source);
    expect(fs.statSync(source).nlink).toBe(2);
    expect(fs.statSync(source).ino).toBe(fs.statSync(move.archivePath).ino);
    const recovered = await runPublic(store, mode);
    expect(recovered).toMatchObject({ exitCode: 0, report: { targets: [{ issues: [] }] } });
    expect(readManifest(manifestPath).restore?.consumedArchives).toContain(move.archivePath);
    expectMissing(move.archivePath);
    if (mode === "restore") {
      expect(fs.statSync(source).nlink).toBe(1);
      expectFiles(original, source);
      const reimport = await importLegacyStore(store);
      expect(reimport.targets[0]?.issues).toEqual([]);
    }
    expect(await cleanupRecovery(store)).toMatchObject({
      status: "complete",
      totals: { removedFiles: 2 },
    });
  },
);

it.each(["mismatch", "third-link"] as const)(
  "refuses public recovery of a recorded publication with %s",
  async (fault) => {
    const { store, imported } = await createVerifiedRecoveryStore();
    const manifest = readManifest(imported.migrationRun?.manifestPath);
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
      await expect(runPublic(store, mode)).rejects.toThrow(
        /hard-linked|archive identity or contents changed/,
      );
      expectFiles(before, move.sourcePath, move.archivePath);
      expect(fs.statSync(move.sourcePath).nlink).toBe(fault === "third-link" ? 3 : 2);
    }
  },
);

it("protects historical v2 restore metadata and its retained transcript dependency from cleanup", async () => {
  const { store, manifestPath, manifest, archivePath } = createHistoricalRestoreStore(2);
  const target = expectDefined(manifest.targets[0], "historical cleanup target");
  const index = expectDefined(
    target.plannedMoves.find((move) => move.kind === "legacy-store"),
    "historical index",
  );
  const indexIdentity = readMigrationArtifactIdentity(index.archivePath);
  const indexBytes = fs.readFileSync(index.archivePath);
  const transcriptBytes = fs.readFileSync(archivePath);
  fs.writeFileSync(store.transcriptPath, "new source history\n", { mode: 0o600 });
  const publish = durability.publishFileExclusive;
  using publicationSpy = vi
    .spyOn(durability, "publishFileExclusive")
    .mockImplementation(async (options) => {
      if (options.sourcePath === index.archivePath && options.targetPath === index.sourcePath) {
        throw Object.assign(new Error("injected unsupported hard link"), { code: "EXDEV" });
      }
      return publish(options);
    });
  using copySpy = vi.spyOn(fs, "copyFileSync");
  using asyncCopySpy = vi.spyOn(asyncFs, "copyFile");
  const failed = await runPublic(store, "restore");
  expect(failed.exitCode).toBe(1);
  containsObjects(failed.report.targets[0]?.restore?.conflicts, { archivePath: index.archivePath });
  expect(publicationSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      sourcePath: index.archivePath,
      targetPath: index.sourcePath,
      strategy: "link-required",
    }),
  );
  expect(copySpy).not.toHaveBeenCalled();
  expect(asyncCopySpy).not.toHaveBeenCalled();
  publicationSpy.mockRestore();
  copySpy.mockRestore();
  asyncCopySpy.mockRestore();
  const recorded = readManifest(manifestPath);
  expect(recorded.manifestVersion).toBe(2);
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
  expectFiles(indexBytes, index.archivePath);
  expectFiles(transcriptBytes, archivePath);
  expectFiles("new source history\n", store.transcriptPath);
  expectMissing(index.sourcePath, target.sqlitePath);
});
