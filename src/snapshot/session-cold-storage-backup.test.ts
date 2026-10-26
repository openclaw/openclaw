import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { restoreGitBackupDirectory } from "./git-backup-codec.js";
import { createGitBackup } from "./git-backup.js";
import { expectDatabaseRows, gitBackupRepository } from "./git-backup.test-support.js";
import { expectMissing } from "./local-repository.test-support.js";

const sessionKey = "agent:main:backup-cold-history";
const identity = { role: "agent", agentId: "main" } as const;

async function createColdFixture(state: OpenClawTestState) {
  const { root } = state;
  const sourcePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
  const transcript = await createSessionColdStorageFixture(sourcePath, sessionKey);
  await runSessionColdStorageMaintenance({ config: maintenanceConfig(sourcePath) });
  const archive = transcript
    .database()
    .prepare("SELECT archive_name FROM session_transcript_cold_archives WHERE session_id = ?")
    .get(sessionId);
  if (typeof archive?.archive_name !== "string") {
    throw new Error("The archived transcript has no recorded file");
  }
  const archivePath = resolveSessionColdArchivePath(sourcePath, archive.archive_name);
  return { root, sourcePath, ...transcript, archivePath };
}
const withColdFixture = (
  run: (fixture: Awaited<ReturnType<typeof createColdFixture>>) => Promise<void>,
) =>
  withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) =>
    run(await createColdFixture(state)),
  );

type BackupKind = "full archive capture" | "Git backup";

async function captureFixture(
  kind: BackupKind,
  fixture: Awaited<ReturnType<typeof createColdFixture>>,
): Promise<string> {
  const { root, sourcePath } = fixture;
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
  } else {
    const repository = gitBackupRepository(root, "git-backups");
    await repository.init();
    await repository.configureIdentity();
    await createGitBackup({ ...repository.options, databases: [{ path: sourcePath, identity }] });
    await restoreGitBackupDirectory({
      sourcePath: repository.file("agents", "main"),
      targetPath,
      expectedIdentity: identity,
    });
  }
  return targetPath;
}

it.each(["full archive capture", "Git backup"] as const)(
  "%s restores exact events without the source archive",
  (kind) =>
    withColdFixture(async (fixture) => {
      const restoredPath = await captureFixture(kind, fixture);
      expectDatabaseRows(fixture.sourcePath, {
        "SELECT storage, archive_blob FROM session_transcript_cold_archives": [
          { storage: "file", archive_blob: null },
        ],
      });
      await fs.unlink(fixture.archivePath);
      await restoreSessionColdTranscript({ ...fixture.scope, storePath: restoredPath });
      using restored = new DatabaseSync(restoredPath, { readOnly: true });
      expect(fixture.snapshot(restored).events).toEqual(fixture.original.events);
    }),
);

it("refuses a corrupt authoritative archive", () =>
  withColdFixture(async (fixture) => {
    await fs.writeFile(fixture.archivePath, "corrupt archive");
    await expect(captureFixture("full archive capture", fixture)).rejects.toThrow(
      /failed verification/,
    );
    await expectMissing(path.join(fixture.root, "restored.sqlite"));
  }));
