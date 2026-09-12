import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "../config/sessions/session-cold-storage.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { createBackupSqliteSnapshotPlan } from "../infra/backup-sqlite-snapshot.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { restoreGitBackupDirectory } from "./git-backup-codec.js";
import { createGitBackup } from "./git-backup.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";

const tempDirs = createTempDirTracker();
const databasePaths: string[] = [];
const sessionId = "historical-transcript";
const sessionKey = "agent:main:backup-cold-history";

afterEach(async () => {
  for (const databasePath of databasePaths.splice(0)) {
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
  }
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

async function createColdFixture() {
  const root = tempDirs.make("openclaw-cold-backup-");
  const stateDir = path.join(root, "state");
  const sourcePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  databasePaths.push(sourcePath);
  const scope = { agentId: "main", storePath: sourcePath, sessionKey, sessionId };
  await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [
    { type: "session", id: sessionId, content: "Historical 你好 🦞\nbytes" },
    { type: "message", id: "historical-message", message: { role: "user", content: "retain me" } },
  ]);
  await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: sourcePath });
  await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
  const database = openOpenClawAgentDatabase({ agentId: "main", path: sourcePath }).db;
  database
    .prepare(
      "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
    )
    .run(sessionId);
  const originalRows = database
    .prepare(
      "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
    )
    .all(sessionId);
  expect(
    await runSessionColdStorageMaintenance({
      config: {
        agents: { list: [{ id: "main", agentDir: path.dirname(sourcePath) }] },
        session: {
          store: sourcePath,
          maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
        },
      },
    }),
  ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
  const archive = database
    .prepare("SELECT archive_name FROM session_transcript_cold_archives WHERE session_id = ?")
    .get(sessionId);
  if (typeof archive?.archive_name !== "string") {
    throw new Error("The archived transcript has no recorded file");
  }
  const archivePath = resolveSessionColdArchivePath(sourcePath, archive.archive_name);
  return { root, stateDir, sourcePath, scope, originalRows, archivePath };
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
    const tempDir = path.join(root, "archive-stage");
    await fs.mkdir(tempDir);
    const plan = await createBackupSqliteSnapshotPlan({
      inventory: {
        stateDir,
        agentRoots: [
          { agentId: "main", sourcePath: path.dirname(sourcePath), databasePath: sourcePath },
        ],
        regenerableRoots: [],
        isIncluded: () => true,
        isTraversable: () => true,
        isPackageContent: () => false,
        isVolatile: () => false,
      },
      tempDir,
      legacyAuditSnapshots: [],
    });
    const snapshot = plan.snapshots.find((entry) => entry.archiveSourcePath === sourcePath);
    if (!snapshot) {
      throw new Error("The full backup inventory did not capture the agent database");
    }
    await fs.copyFile(snapshot.sourcePath, targetPath);
  } else if (kind === "SQLite snapshot") {
    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: path.join(root, "snapshots"),
    });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "agent", agentId: "main" },
    });
    await provider.restoreFresh(snapshot.ref, targetPath);
  } else {
    const repositoryPath = path.join(root, "git-backups");
    await createGitBackup({
      repositoryPath,
      stateDir,
      databases: [{ path: sourcePath, identity: { role: "agent", agentId: "main" } }],
      gitEnv: {
        ...process.env,
        GIT_AUTHOR_NAME: "OpenClaw Backup Test",
        GIT_AUTHOR_EMAIL: "backup@example.invalid",
        GIT_COMMITTER_NAME: "OpenClaw Backup Test",
        GIT_COMMITTER_EMAIL: "backup@example.invalid",
      },
    });
    await restoreGitBackupDirectory({
      sourcePath: path.join(repositoryPath, "agents", "main"),
      targetPath,
      expectedIdentity: { role: "agent", agentId: "main" },
    });
  }
  return targetPath;
}

describe("cold transcript backup portability", () => {
  it.each(backupKinds)("%s restores exact events without the source archive", async (kind) => {
    const fixture = await createColdFixture();
    const restoredPath = await captureFixture(kind, fixture);
    const source = openOpenClawAgentDatabase({ agentId: "main", path: fixture.sourcePath }).db;
    expect(
      source.prepare("SELECT storage, archive_blob FROM session_transcript_cold_archives").get(),
    ).toEqual({
      storage: "file",
      archive_blob: null,
    });
    await fs.unlink(fixture.archivePath);
    databasePaths.push(restoredPath);
    await restoreSessionColdTranscript({ ...fixture.scope, storePath: restoredPath });
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      expect(
        restored
          .prepare(
            "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
          )
          .all(sessionId),
      ).toEqual(fixture.originalRows);
      expect(restored.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it.each(backupKinds)("%s refuses a corrupt authoritative archive", async (kind) => {
    const fixture = await createColdFixture();
    await fs.writeFile(fixture.archivePath, "corrupt archive");
    await expect(captureFixture(kind, fixture)).rejects.toThrow(/failed verification/);
    await expect(fs.access(path.join(fixture.root, "restored.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
