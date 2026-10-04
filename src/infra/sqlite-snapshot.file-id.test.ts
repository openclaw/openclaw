import { createHash } from "node:crypto";
import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { publishVerifiedSqliteFile } from "./sqlite-snapshot.js";
import { prepareUpdateDatabaseRestoreSourceInProcess } from "./update-database-restore-source.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each([
  "publication",
  "replacement-before-open",
  "replacement-before-sync",
  "replacement-before-publish",
  "restore",
] as const)("preserves exact file identities above 2^53 (%s)", async (operationKind) => {
  const replace = operationKind.startsWith("replacement");
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-file-id-")));
  directories.push(directory);
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "target.sqlite");
  const displacedPath = path.join(directory, "displaced.sqlite");
  const database = new DatabaseSync(sourcePath);
  try {
    database.exec(
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence(rowid,value) VALUES(71,'keep');",
    );
  } finally {
    database.close();
  }
  const bytes = await fs.readFile(sourcePath);
  const native = getFsSafeNativeConfig();
  const open = fs.open.bind(fs);
  const lstat = fs.lstat.bind(fs);
  const lstatSync = fsSync.lstatSync.bind(fsSync);
  const statSync = fsSync.statSync.bind(fsSync);
  const fstatSync = fsSync.fstatSync.bind(fsSync);
  const ids = new Map<string, bigint>();
  const createdId = 2n ** 54n + 1n;
  let replaced = false;
  let stagedPath: string | undefined;
  function project<T extends Stats | BigIntStats>(stat: T, exact: BigIntStats): T {
    const id = ids.get(`${exact.dev}:${exact.ino}`);
    if (id !== undefined) {
      stat.ino = typeof stat.ino === "bigint" ? id : Number(id);
    }
    return stat;
  }
  function observe(file: fsSync.PathLike): BigIntStats {
    const exact = lstatSync(file, { bigint: true });
    if (exact.isFile() && String(file).startsWith(`${directory}${path.sep}`)) {
      const key = `${exact.dev}:${exact.ino}`;
      if (!ids.has(key)) {
        ids.set(key, createdId + 8n * BigInt(ids.size));
      }
    }
    return exact;
  }
  try {
    // Model only OS stat representation. All copying, receipts, hashing and publication are real.
    // The Node fallback lets the same observations reach the dependency's descriptor fences.
    configureFsSafeNative({ mode: "off" });
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstatSync(...args);
      return stat ? project(stat, observe(args[0])) : stat;
    });
    vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
      const stat = statSync(...args);
      return stat ? project(stat, observe(args[0])) : stat;
    });
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) =>
      project(fstatSync(...args), fstatSync(args[0], { bigint: true })),
    );
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) =>
      project(await lstat(...args), observe(args[0])),
    );
    async function replaceStagedFile(file: string) {
      const original = observe(file);
      const originalId = ids.get(`${original.dev}:${original.ino}`)!;
      await fs.rename(file, displacedPath);
      await fs.writeFile(file, bytes);
      const replacement = observe(file);
      ids.set(`${replacement.dev}:${replacement.ino}`, originalId - 1n);
      expect(Number(originalId - 1n)).toBe(Number(originalId));
      replaced = true;
    }
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = String(args[0]);
      const isStaged =
        args[1] === "r+" && path.basename(path.dirname(file)).startsWith(".sqlite-publish-");
      if (isStaged) {
        stagedPath = file;
        if (operationKind === "replacement-before-open" && !replaced) {
          await replaceStagedFile(file);
        }
      }
      const handle = await open(...args);
      try {
        const stat = handle.stat.bind(handle);
        observe(args[0]);
        vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) =>
          project(await stat(...statArgs), fstatSync(handle.fd, { bigint: true })),
        );
        if (isStaged && operationKind === "replacement-before-sync") {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            if (!replaced) {
              await replaceStagedFile(file);
            }
            await sync();
          });
        }
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    });
    const content = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
    const operation =
      operationKind === "restore"
        ? prepareUpdateDatabaseRestoreSourceInProcess({
            baseline: { path: sourcePath, snapshotPath: sourcePath, userVersion: 0, ...content },
            currentPath: sourcePath,
            targetPath,
            stagingRoot: directory,
          })
        : publishVerifiedSqliteFile({
            sourcePath,
            sourceIdentity: await fs.lstat(sourcePath),
            targetPath,
            expectedContent: content,
            beforePublish: async () => {
              if (operationKind === "replacement-before-publish") {
                expect(stagedPath).toBeDefined();
                await replaceStagedFile(stagedPath!);
              }
            },
          });
    if (replace) {
      await expect(operation).rejects.toThrow(/snapshot (?:target|staging file|file) changed/);
      expect(replaced).toBe(true);
      await expect(fs.readFile(displacedPath)).resolves.toEqual(bytes);
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await operation;
      await expect(fs.readFile(targetPath)).resolves.toEqual(bytes);
      const reopened = new DatabaseSync(targetPath, { readOnly: true });
      try {
        expect(reopened.prepare("SELECT rowid,value FROM evidence").all()).toEqual([
          { rowid: 71, value: "keep" },
        ]);
        expect(reopened.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        reopened.close();
      }
    }
    await expect(fs.readFile(sourcePath)).resolves.toEqual(bytes);
    expect((await fs.readdir(directory)).toSorted()).toEqual(
      replace ? ["displaced.sqlite", "source.sqlite"] : ["source.sqlite", "target.sqlite"],
    );
  } finally {
    vi.restoreAllMocks();
    configureFsSafeNative(native);
  }
});
