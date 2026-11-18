import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createBackupScratchDirectory, finishBackupScratch } from "./backup-scratch.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { acquireSqliteStagingToken } from "./sqlite-staging-token.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const posixIt = process.platform === "win32" ? it.skip : it;

// Deleted files this process still holds open keep their disk space allocated until exit.
function deletedOpenFiles(): Set<string> {
  const files = new Set<string>();
  for (const name of fs.readdirSync("/dev/fd")) {
    try {
      const stat = fs.fstatSync(Number(name), { bigint: true });
      if (stat.isFile() && stat.nlink === 0n) {
        files.add(`${stat.dev}:${stat.ino}`);
      }
    } catch {
      // The directory listing's own descriptor is closed by the time it is inspected.
    }
  }
  return files;
}

function leakedSince(before: Set<string>): string[] {
  return [...deletedOpenFiles()].filter((file) => !before.has(file));
}

function createSource(root: string): string {
  const source = path.join(root, "source.sqlite");
  using database = new DatabaseSync(source);
  database.exec(
    "CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (randomblob(262144));",
  );
  return source;
}

posixIt("releases the online-copy staging file after a verified snapshot", async () => {
  const root = directories.make("backup-staging-retirement-");
  const source = createSource(root);
  const before = deletedOpenFiles();

  await createVerifiedSqliteSnapshot({
    sourcePath: source,
    targetPath: path.join(root, "snapshot.sqlite"),
  });

  expect(fs.readdirSync(root).toSorted()).toEqual(["snapshot.sqlite", "source.sqlite"]);
  expect(leakedSince(before)).toEqual([]);
});

posixIt("releases snapshot and verification databases when backup scratch retires", async () => {
  const root = directories.make("backup-scratch-admission-");
  const source = createSource(root);
  const scratchRoot = path.join(root, "tmp");
  fs.mkdirSync(scratchRoot);
  const scratch = await createBackupScratchDirectory(scratchRoot);
  // Capture publishes the snapshot into scratch; verify extracts and checks a copy under payload.
  await createVerifiedSqliteSnapshot({
    sourcePath: source,
    targetPath: path.join(scratch.directory, "openclaw-state-db-0.sqlite"),
  });
  const extracted = path.join(scratch.directory, "payload", "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(extracted), { recursive: true });
  fs.copyFileSync(source, extracted);
  const verification = openNodeSqliteDatabase(extracted, { readOnly: true });
  assertSqliteIntegrity(verification, "payload/state/openclaw.sqlite");
  verification.close();
  // A payload can have the same basename as the root control; only the root control is excluded.
  const nestedControl = path.join(scratch.directory, "payload", "owner.sqlite");
  fs.copyFileSync(source, nestedControl);
  openNodeSqliteDatabase(nestedControl, { readOnly: true }).close();
  const before = deletedOpenFiles();
  const remove = scratch.boundary.remove.bind(scratch.boundary);
  let observedPayloadRemoval = false;
  using removal = vi.spyOn(scratch.boundary, "remove").mockImplementation(async (...args) => {
    observedPayloadRemoval = true;
    // The real second connection must remain excluded until payload removal has finished.
    expect(() => acquireSqliteStagingToken(scratch.directory, "reclaim")).toThrow(/locked|busy/i);
    expect(fs.existsSync(path.join(scratch.directory, "owner.sqlite"))).toBe(true);
    return remove(...args);
  });

  await expect(finishBackupScratch(scratch, () => {})).resolves.toBeUndefined();
  expect(observedPayloadRemoval).toBe(true);
  expect(removal).toHaveBeenCalled();

  expect(fs.readdirSync(scratchRoot)).toEqual([]);
  expect(leakedSince(before)).toEqual([]);
});
