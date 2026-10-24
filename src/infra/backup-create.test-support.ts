import * as tar from "tar";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { BackupResourceInventory } from "../commands/backup-resource-inventory.js";
import type { BackupCreateResult } from "./backup-create.js";

export function useIsolatedBackupTempRoot(): void {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    // Backup maintenance must not inspect another test's in-flight scratch.
    const tempRoot = tempDirs.make("backup-tests-");
    vi.stubEnv("TMPDIR", tempRoot);
    vi.stubEnv("TMP", tempRoot);
    vi.stubEnv("TEMP", tempRoot);
  });
}

export function createBackupClassificationInventory(stateDir: string): BackupResourceInventory {
  return {
    stateDir,
    agentRoots: [],
    coreDatabases: [],
    coreDatabaseSourcePaths: [],
    resolveSqliteSource: () => ({ role: "plugin" }),
    regenerableRoots: [],
    isIncluded: () => true,
    isTraversable: () => true,
    isPackageContent: () => false,
    isVolatile: () => false,
  };
}

export function makeBackupResult(overrides: Partial<BackupCreateResult> = {}): BackupCreateResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "openclaw-backup-2026-01-01",
    archivePath: "/tmp/openclaw-backup.tar.gz",
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: false,
    assets: [],
    skipped: [],
    skippedVolatileCount: 0,
    ...overrides,
  };
}

export async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

export async function listArchiveEntryDetails(
  archivePath: string,
): Promise<Array<{ path: string; linkpath?: string; type?: string }>> {
  const entries: Array<{ path: string; linkpath?: string; type?: string }> = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
      entry.resume();
    },
  });
  return entries;
}
