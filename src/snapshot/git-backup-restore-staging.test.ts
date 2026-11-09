import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as privateMode from "../infra/private-mode.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { dumpGitBackupDatabase, restoreGitBackupDirectory } from "./git-backup-codec.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

async function readBackupFiles(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await readBackupFiles(entryPath))) {
        files[path.join(entry.name, name)] = content;
      }
    } else {
      files[entry.name] = await fs.readFile(entryPath, "utf8");
    }
  }
  return files;
}

it.each(["private-mode", "file-open", "file-close", "sqlite-open", "sqlite-init", "none"] as const)(
  "cleans only its own restore staging after %s",
  async (fault) => {
    const root = tempDirs.make("git-backup-restore-staging-");
    const sourcePath = path.join(root, "source.sqlite");
    const outputPath = path.join(root, "dump");
    const targetPath = path.join(root, "restored.sqlite");
    const unrelatedPath = path.join(root, ".git-backup-restore-retained");
    await fs.mkdir(unrelatedPath);
    await fs.writeFile(path.join(unrelatedPath, "keep.txt"), "unrelated private work");
    const source = openOpenClawStateDatabase({ path: sourcePath }).db;
    source.exec("CREATE TABLE content (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    source.prepare("INSERT INTO content VALUES (?, ?)").run(1, "original");
    await closeOpenClawStateDatabaseAsync();
    await dumpGitBackupDatabase({
      snapshotPath: sourcePath,
      outputPath,
      identity: { role: "global" },
    });
    const sourceBytes = await fs.readFile(sourcePath);
    const backupFiles = await readBackupFiles(outputPath);
    const rootEntries = (await fs.readdir(root)).toSorted();
    const failure = Object.assign(new Error(`Restore fault: ${fault}`), {
      code: fault === "private-mode" ? "EACCES" : "EIO",
    });
    let openedDatabase: DatabaseSync | undefined;
    const isRestoreStaging = (pathname: string) =>
      path.basename(path.dirname(pathname)).startsWith(".git-backup-restore-") ||
      path.basename(pathname).startsWith(".git-backup-restore-");

    if (fault === "private-mode") {
      const applyMode = privateMode.applyPrivateModeSync;
      vi.spyOn(privateMode, "applyPrivateModeSync").mockImplementation((pathname, mode) => {
        if (isRestoreStaging(pathname)) {
          throw failure;
        }
        return applyMode(pathname, mode);
      });
    } else if (fault === "file-open" || fault === "file-close") {
      const openFile = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (!isRestoreStaging(String(args[0]))) {
          return await openFile(...args);
        }
        if (process.platform !== "win32") {
          const directory = await fs.stat(path.dirname(String(args[0])));
          expect(directory.mode & 0o777).toBe(0o700);
        }
        if (fault === "file-open") {
          throw failure;
        }
        const handle = await openFile(...args);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async () => {
          // Release the real descriptor, then exercise a rejected close result.
          await close();
          throw failure;
        });
        return handle;
      });
    } else if (fault === "sqlite-open" || fault === "sqlite-init") {
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
        if (!isRestoreStaging(pathname)) {
          return openDatabase(pathname, options);
        }
        if (fault === "sqlite-open") {
          throw failure;
        }
        openedDatabase = openDatabase(pathname, options);
        vi.spyOn(openedDatabase, "exec").mockImplementationOnce(() => {
          throw failure;
        });
        return openedDatabase;
      });
    }

    const restoring = restoreGitBackupDirectory({ sourcePath: outputPath, targetPath });
    if (fault === "none") {
      const restored = await restoring;
      expect(restored.targetPath).toBe(targetPath);
      expect(restored.tables.find((table) => table.table === "content")).toMatchObject({
        rows: 1,
        ok: true,
      });
      const database = nodeSqlite.openNodeSqliteDatabase(targetPath, { readOnly: true });
      try {
        expect(database.prepare("SELECT id, body FROM content").all()).toEqual([
          { id: 1, body: "original" },
        ]);
        expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally {
        database.close();
      }
      if (process.platform !== "win32") {
        expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o600);
      }
    } else {
      await expect(restoring).rejects.toBe(failure);
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      if (openedDatabase) {
        expect(openedDatabase.isOpen).toBe(false);
      }
    }
    expect((await fs.readdir(root)).toSorted()).toEqual(
      fault === "none" ? [...rootEntries, "restored.sqlite"].toSorted() : rootEntries,
    );
    expect(await readBackupFiles(outputPath)).toEqual(backupFiles);
    expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
    expect(await fs.readFile(path.join(unrelatedPath, "keep.txt"), "utf8")).toBe(
      "unrelated private work",
    );
  },
);
