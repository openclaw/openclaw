import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { embedSessionColdArchivesInSnapshot } from "../config/sessions/session-cold-storage-backup.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId as sessionId,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import { buildBackupArchivePath } from "../infra/backup-archive-path-policy.js";
import {
  listArchiveEntries,
  listArchiveEntryDetails,
} from "../infra/backup-create.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { restoreGitBackupDirectory } from "./git-backup-codec.js";
import { createGitBackup } from "./git-backup.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";

const states: OpenClawTestState[] = [];
const sessionKey = "agent:main:backup-cold-history";
const identity = { role: "agent", agentId: "main" } as const;

afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

async function createColdFixture() {
  const state = await createOpenClawTestState({ layout: "state-only", scenario: "minimal" });
  states.push(state);
  const { root, stateDir } = state;
  const sourcePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
  const transcript = await createSessionColdStorageFixture(sourcePath, sessionKey);
  const database = transcript.database();
  expect(
    database
      .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE event_zstd IS NOT NULL")
      .get(),
  ).toEqual({ count: 1 });
  expect(await runSessionColdStorageMaintenance({ config: maintenanceConfig(sourcePath) })).toEqual(
    { archivedTranscripts: 1, externalizedTranscripts: 0 },
  );
  const archive = database
    .prepare("SELECT archive_name FROM session_transcript_cold_archives WHERE session_id = ?")
    .get(sessionId);
  if (typeof archive?.archive_name !== "string") {
    throw new Error("The archived transcript has no recorded file");
  }
  const archivePath = resolveSessionColdArchivePath(sourcePath, archive.archive_name);
  return { root, stateDir, sourcePath, ...transcript, archivePath };
}

type BackupKind = "full archive capture" | "SQLite snapshot" | "Git backup";
const backupKinds: BackupKind[] = ["full archive capture", "SQLite snapshot", "Git backup"];

async function captureFixture(
  kind: BackupKind,
  fixture: Awaited<ReturnType<typeof createColdFixture>>,
): Promise<string> {
  const { root, stateDir, sourcePath } = fixture;
  const targetPath = path.join(root, "restored.sqlite");
  if (kind === "full archive capture") {
    const runtime = createTestRuntime();
    const archive = await backupCreateCommand(runtime, {
      output: path.join(root, "backup.tar.gz"),
      includeWorkspace: false,
    });
    const restored = await backupRestoreCommand(runtime, {
      archive: archive.archivePath,
      target: path.join(root, "restored-archive"),
    });
    // Isolate the database so extracted cold files cannot hide missing embedded bytes.
    await fs.copyFile(
      path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, sourcePath)),
      targetPath,
    );
  } else if (kind === "SQLite snapshot") {
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: path.join(root, "snapshots"),
    });
    const snapshot = await provider.create({
      path: sourcePath,
      identity,
    });
    await provider.restoreFresh(snapshot.ref, targetPath);
  } else {
    const repositoryPath = path.join(root, "git-backups");
    await withEnvAsync(
      {
        GIT_AUTHOR_NAME: "OpenClaw Backup Test",
        GIT_AUTHOR_EMAIL: "backup@example.invalid",
        GIT_COMMITTER_NAME: "OpenClaw Backup Test",
        GIT_COMMITTER_EMAIL: "backup@example.invalid",
      },
      () =>
        createGitBackup({ repositoryPath, stateDir, databases: [{ path: sourcePath, identity }] }),
    );
    await restoreGitBackupDirectory({
      sourcePath: path.join(repositoryPath, "agents", "main"),
      targetPath,
      expectedIdentity: identity,
    });
  }
  return targetPath;
}

it.each(backupKinds)("%s restores exact events without the source archive", async (kind) => {
  const fixture = await createColdFixture();
  const restoredPath = await captureFixture(kind, fixture);
  const source = fixture.database();
  expect(
    source.prepare("SELECT storage, archive_blob FROM session_transcript_cold_archives").get(),
  ).toEqual({
    storage: "file",
    archive_blob: null,
  });
  await fs.unlink(fixture.archivePath);
  await restoreSessionColdTranscript({ ...fixture.scope, storePath: restoredPath });
  using restored = new DatabaseSync(restoredPath, { readOnly: true });
  expect(fixture.snapshot(restored).events).toEqual(fixture.original.events);
  expect(
    restored
      .prepare(
        "SELECT message_id FROM session_transcript_fts WHERE session_transcript_fts MATCH 'Preserved'",
      )
      .all(),
  ).toEqual([{ message_id: "history-assistant" }]);
  expect(restored.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("full backup omits embedded cold files, retains other files, and regenerates cold storage", async () => {
  const fixture = await createColdFixture();
  const coldDir = path.dirname(fixture.archivePath);
  const orphanPath = path.join(coldDir, `${"a".repeat(64)}.jsonl.zst`);
  const symlinkPath = path.join(coldDir, "retained-link.zst");
  await fs.writeFile(orphanPath, "unreferenced cold file");
  await fs.symlink(path.basename(orphanPath), symlinkPath);
  const runtime = createTestRuntime();
  const backup = await backupCreateCommand(runtime, {
    output: path.join(fixture.root, "cold-backup.tar.gz"),
    includeWorkspace: false,
  });
  const archivedPath = (pathname: string) => buildBackupArchivePath(backup.archiveRoot, pathname);
  const entries = await listArchiveEntries(backup.archivePath);
  expect(entries).not.toContain(archivedPath(fixture.archivePath));
  expect(entries).toContain(archivedPath(orphanPath));
  expect(
    (await listArchiveEntryDetails(backup.archivePath)).find(
      (entry) => entry.path === archivedPath(symlinkPath),
    )?.type,
  ).toBe("SymbolicLink");
  await expect(
    backupVerifyCommand(runtime, { archive: backup.archivePath }),
  ).resolves.toMatchObject({
    ok: true,
  });
  const restored = await backupRestoreCommand(runtime, {
    archive: backup.archivePath,
    target: path.join(fixture.root, "restored-full-archive"),
  });
  const restoredDatabasePath = path.join(restored.targetPath, archivedPath(fixture.sourcePath));
  const restoredColdPath = resolveSessionColdArchivePath(
    restoredDatabasePath,
    path.basename(fixture.archivePath),
  );
  await expect(fs.access(restoredColdPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await runSessionColdStorageMaintenance({ config: maintenanceConfig(restoredDatabasePath) }),
  ).toEqual({ archivedTranscripts: 0, externalizedTranscripts: 1 });
  expect(await fs.readFile(restoredColdPath)).toEqual(await fs.readFile(fixture.archivePath));
  await restoreSessionColdTranscript({ ...fixture.scope, storePath: restoredDatabasePath });
  using database = new DatabaseSync(restoredDatabasePath, { readOnly: true });
  expect(fixture.snapshot(database).events).toEqual(fixture.original.events);
  expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
});

it("retains an external file when the captured archive already uses SQLite storage", async () => {
  const fixture = await createColdFixture();
  expect(
    await embedSessionColdArchivesInSnapshot({
      database: fixture.database(),
      sourceStorePath: fixture.sourcePath,
    }),
  ).toEqual([fixture.archivePath]);
  const runtime = createTestRuntime();
  const backup = await backupCreateCommand(runtime, {
    output: path.join(fixture.root, "sqlite-cold-backup.tar.gz"),
    includeWorkspace: false,
  });
  expect(await listArchiveEntries(backup.archivePath)).toContain(
    buildBackupArchivePath(backup.archiveRoot, fixture.archivePath),
  );
  await expect(
    backupVerifyCommand(runtime, { archive: backup.archivePath }),
  ).resolves.toMatchObject({
    ok: true,
  });
});

it("retains a symlink at a verified embedded archive path", async () => {
  const fixture = await createColdFixture();
  const targetPath = path.join(path.dirname(fixture.archivePath), `${"b".repeat(64)}.jsonl.zst`);
  await fs.rename(fixture.archivePath, targetPath);
  await fs.symlink(path.basename(targetPath), fixture.archivePath);
  const runtime = createTestRuntime();
  const backup = await backupCreateCommand(runtime, {
    output: path.join(fixture.root, "linked-cold-backup.tar.gz"),
    includeWorkspace: false,
  });
  const archivedPath = buildBackupArchivePath(backup.archiveRoot, fixture.archivePath);
  expect(
    (await listArchiveEntryDetails(backup.archivePath)).find((entry) => entry.path === archivedPath)
      ?.type,
  ).toBe("SymbolicLink");
  await expect(
    backupVerifyCommand(runtime, { archive: backup.archivePath }),
  ).resolves.toMatchObject({
    ok: true,
  });
  const restored = await backupRestoreCommand(runtime, {
    archive: backup.archivePath,
    target: path.join(fixture.root, "restored-linked-cold"),
  });
  expect(await fs.readFile(path.join(restored.targetPath, archivedPath))).toEqual(
    await fs.readFile(targetPath),
  );
});

it.each(["full archive capture", "SQLite snapshot"] as const)(
  "%s refuses a corrupt authoritative archive",
  async (kind) => {
    const fixture = await createColdFixture();
    await fs.writeFile(fixture.archivePath, "corrupt archive");
    await expect(captureFixture(kind, fixture)).rejects.toThrow(/failed verification/);
    await expect(fs.access(path.join(fixture.root, "restored.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
