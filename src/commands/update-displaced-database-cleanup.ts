/** `<db>.migrated-<runId>` files a database rollback moved aside, released by later run outcomes. */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isPathInside } from "../infra/path-guards.js";
import { hasSymbolicLinkInDirectoryPath } from "../infra/session-sqlite-migration-manifest.js";
import {
  displacedDatabasePath,
  displacedDatabaseReceiptPath,
  parseDisplacedDatabaseName,
  readDisplacedDatabaseReceipt,
  type DisplacedDatabaseReceipt,
} from "../infra/update-displaced-database-receipt.js";
import type { RecoveryInventoryScan } from "./recovery-inventory-scan.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";
import type { UpdateRunArtifactOwnership } from "./update-run-artifact-ownership.js";

type Family = {
  path: string;
  runId: string;
  receiptPath?: string;
  receipt?: DisplacedDatabaseReceipt;
  files: Map<string, fs.BigIntStats>;
};
export type DisplacedDatabaseRetirement = Map<
  string,
  { receiptPath: string; receipt: DisplacedDatabaseReceipt }
>;

/**
 * Where a rollback writes: the shared state directory, each default agent directory, and
 * configured agent directories. Callers keep only those inside the state directory.
 */
function databaseDirectories(
  stateDir: string,
  scan: RecoveryInventoryScan | undefined,
  agentDirectories: readonly string[],
): string[] {
  const directories = [
    path.join(stateDir, "state"),
    ...agentDirectories.map((dir) => path.resolve(dir)),
  ];
  const agents = path.join(stateDir, "agents");
  if (!fs.lstatSync(agents, { throwIfNoEntry: false })?.isDirectory()) {
    return directories;
  }
  for (const entry of scan?.directory(agents) ?? fs.readdirSync(agents, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      directories.push(path.join(agents, entry.name, "agent"));
    }
  }
  return [...new Set(directories)];
}

/** Discovery only: names suggest a family; only a matching receipt proves the updater made it. */
export function scanDisplacedDatabases(
  stateDir: string,
  scan?: RecoveryInventoryScan,
  agentDirectories: readonly string[] = [],
): Family[] {
  const families = new Map<string, Family>();
  const family = (familyPath: string, runId: string) => {
    const existing = families.get(familyPath);
    if (existing) {
      return existing;
    }
    const created: Family = { path: familyPath, runId, files: new Map() };
    families.set(familyPath, created);
    return created;
  };
  for (const directory of databaseDirectories(stateDir, scan, agentDirectories)) {
    if (
      !isPathInside(stateDir, directory) ||
      !fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() ||
      hasSymbolicLinkInDirectoryPath(directory)
    ) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = [
        ...(scan?.directory(directory) ?? fs.readdirSync(directory, { withFileTypes: true })),
      ];
    } catch {
      // An unreadable directory proves nothing; the rest of the inventory still runs.
      continue;
    }
    const unmatched: string[] = [];
    for (const entry of entries) {
      const parsed = parseDisplacedDatabaseName(entry.name);
      // Rollbacks move SQLite families only; other `.migrated-*` names belong to other owners.
      if (!parsed || !/\.(?:sqlite3?|db)$/u.test(parsed.databaseName)) {
        continue;
      }
      if (!parsed.receipt) {
        unmatched.push(entry.name);
        continue;
      }
      const receiptPath = path.join(directory, entry.name);
      // Status and read-only Doctor share one metadata budget; an unread receipt proves nothing.
      if (scan && !scan.metadata(receiptPath)) {
        continue;
      }
      const receipt = readDisplacedDatabaseReceipt(receiptPath);
      const expectedPath = path.join(directory, parsed.databaseName);
      // The receipt must sit at the one name its own contents imply.
      if (
        !receipt ||
        receipt.databasePath !== expectedPath ||
        displacedDatabaseReceiptPath(receipt.databasePath, receipt.runId) !== receiptPath
      ) {
        // An unreadable or foreign receipt proves nothing; its family stays unproven.
        continue;
      }
      const item = family(displacedDatabasePath(expectedPath, receipt.runId), receipt.runId);
      item.receipt = receipt;
      item.receiptPath = receiptPath;
    }
    const receipted = new Map(
      [...families.values()].flatMap((item) =>
        (item.receipt?.files ?? []).map((file) => [file.path, item] as const),
      ),
    );
    for (const name of unmatched) {
      const filePath = path.join(directory, name);
      const stat = fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
      if (!stat) {
        continue;
      }
      const owner = receipted.get(filePath);
      if (owner) {
        owner.files.set(filePath, stat);
        continue;
      }
      const parsed = parseDisplacedDatabaseName(name)!;
      // Files beside a receipt it does not list join that family, which then cannot be proven.
      family(
        displacedDatabasePath(path.join(directory, parsed.databaseName), parsed.runId),
        parsed.runId,
      ).files.set(filePath, stat);
    }
  }
  return [...families.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

function matchesReceipt(
  stat: fs.BigIntStats,
  expected: DisplacedDatabaseReceipt["files"][number] | undefined,
  file?: string,
): boolean {
  return (
    expected !== undefined &&
    stat.isFile() &&
    stat.nlink === 1n &&
    (String(stat.dev) === expected.dev || remountedBesideDirectory(stat, file)) &&
    String(stat.ino) === expected.ino &&
    String(stat.size) === expected.size &&
    String(stat.mtimeNs) === expected.mtimeNs
  );
}

/**
 * A reboot can renumber a volume (APFS): the device changes while inode, size and mtime stay.
 * Accept that only for a file still on the same volume as the directory that holds it.
 */
function remountedBesideDirectory(stat: fs.BigIntStats, file: string | undefined): boolean {
  if (!file) {
    return false;
  }
  const directory = fs.lstatSync(path.dirname(file), { bigint: true, throwIfNoEntry: false });
  return directory?.isDirectory() === true && directory.dev === stat.dev;
}

export function classifyDisplacedDatabases(
  families: readonly Family[],
  ownership: UpdateRunArtifactOwnership | undefined,
): { artifacts: RecoveryCleanupArtifact[]; retirement: DisplacedDatabaseRetirement } {
  const artifacts: RecoveryCleanupArtifact[] = [];
  const retirement: DisplacedDatabaseRetirement = new Map();
  for (const item of families) {
    const bytes = [...item.files.values()].reduce(
      (total, stat) => total + (stat.isFile() ? Number(stat.size) : 0),
      0,
    );
    const artifact: RecoveryCleanupArtifact = {
      kind: "displaced-database",
      path: item.path,
      runs: [item.runId],
      bytes,
      outcome: "protected",
      reason: "unreceipted-displaced-database",
    };
    artifacts.push(artifact);
    if (!item.receipt || !item.receiptPath) {
      artifact.detail = "Named like a rollback's migrated database, with no matching receipt.";
      continue;
    }
    const listed = new Map(item.receipt.files.map((file) => [file.path, file]));
    const changed = [...item.files].find(
      ([filePath, stat]) => !matchesReceipt(stat, listed.get(filePath), filePath),
    );
    if (changed) {
      Object.assign(artifact, {
        outcome: "blocked",
        reason: "displaced-database-changed",
        detail: `${changed[0]} is not the file the rollback recorded.`,
      });
      continue;
    }
    const live = fs.lstatSync(item.receipt.databasePath, { bigint: true, throwIfNoEntry: false });
    if (!live?.isFile() || live.nlink !== 1n) {
      Object.assign(artifact, {
        outcome: "blocked",
        reason: "live-database-missing",
        detail: `${item.receipt.databasePath} is missing or aliased; its moved-aside copy is kept.`,
      });
      continue;
    }
    Object.assign(
      artifact,
      ownership?.classify(item.runId, item.receipt.databasePath) ?? {
        outcome: "protected",
        reason: "unreadable-update-history",
      },
    );
    if (artifact.outcome === "candidate") {
      artifact.detail = "Migrated database a rollback moved aside; superseded by a later update.";
      artifact.consequence =
        "Permanently deletes the database state the rolled-back update had migrated.";
      retirement.set(item.path, { receiptPath: item.receiptPath, receipt: item.receipt });
    }
  }
  return { artifacts, retirement };
}

/** Caller holds cleanup authority; every file is re-proven against its receipt before unlink. */
export async function retireDisplacedDatabases(params: {
  selected: RecoveryCleanupArtifact[];
  retirement: DisplacedDatabaseRetirement;
  assertCurrent: () => void;
}): Promise<void> {
  for (const item of params.selected) {
    let removedBytes = 0;
    try {
      const owned = params.retirement.get(item.path);
      if (
        !owned ||
        hasSymbolicLinkInDirectoryPath(path.dirname(item.path)) ||
        !isDeepStrictEqual(readDisplacedDatabaseReceipt(owned.receiptPath), owned.receipt)
      ) {
        throw new Error("displaced database receipt changed after selection");
      }
      // As for Doctor backups: never remove a copy while its live database is missing.
      const live = fs.lstatSync(owned.receipt.databasePath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (!live?.isFile() || live.nlink !== 1n) {
        throw new Error(
          `live database ${owned.receipt.databasePath} is missing or aliased; the copy is kept`,
        );
      }
      for (const file of owned.receipt.files) {
        params.assertCurrent();
        const stat = fs.lstatSync(file.path, { bigint: true, throwIfNoEntry: false });
        if (!stat) {
          continue;
        }
        if (!matchesReceipt(stat, file, file.path)) {
          throw new Error(`${file.path} changed after selection`);
        }
        await fs.promises.unlink(file.path);
        removedBytes += Number(stat.size);
      }
      // The receipt goes last: an interrupted removal stays attributed, so a rerun finishes it.
      params.assertCurrent();
      await fs.promises.unlink(owned.receiptPath);
      item.outcome = "removed";
      item.removedBytes = removedBytes;
      item.reason = "displaced-database-retired";
    } catch (error) {
      item.outcome = "failed";
      item.reason = "displaced-database-retirement-failed";
      item.detail = String(error);
      if (removedBytes > 0) {
        item.removedBytes = removedBytes;
      }
    }
  }
}
