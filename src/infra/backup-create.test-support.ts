import * as tar from "tar";
import type { BackupResourceInventory } from "../commands/backup-resource-inventory.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { backupCase, isolateBackupScratch } from "./backup-create-family.test-support.js";
import type { BackupCreateResult } from "./backup-create.js";

export const withIsolatedBackupState: typeof withOpenClawTestState = (options, run) =>
  withOpenClawTestState(options, async (state) => {
    await isolateBackupScratch(state);
    return run(state);
  });

export function isolatedBackupCase(options: Parameters<typeof backupCase>[0]) {
  return <Args extends unknown[]>(
    run: (state: OpenClawTestState, ...args: Args) => Promise<void>,
  ) =>
    backupCase(options)(async (state, ...args: Args) => {
      await isolateBackupScratch(state);
      await run(state, ...args);
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
    isIncludedByOwner: () => true,
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
