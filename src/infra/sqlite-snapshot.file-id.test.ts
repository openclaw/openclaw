import { createHash } from "node:crypto";
import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { publishVerifiedSqliteFile, createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { prepareUpdateDatabaseRestoreSourceInProcess } from "./update-database-restore-source.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function withDatabase<T>(file: string, readOnly: boolean, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function assertSnapshot(file: string) {
  withDatabase(file, true, (db) => {
    expect(db.prepare("SELECT rowid,value FROM evidence").all()).toEqual([
      { rowid: 71, value: "keep" },
    ]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
}

function fixture(target = "target.sqlite") {
  const directory = fsSync.realpathSync(directories.make("sqlite-snapshot-file-"));
  const sourcePath = path.join(directory, "source.sqlite");
  withDatabase(sourcePath, false, (database) =>
    database.exec(
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence(rowid,value) VALUES(71,'keep');",
    ),
  );
  return {
    directory,
    sourcePath,
    targetPath: path.join(directory, target),
    bytes: fsSync.readFileSync(sourcePath),
  };
}

function changeSnapshotBytes(file: string) {
  const writer = fsSync.openSync(file, "r+");
  try {
    fsSync.writeSync(writer, Buffer.from("lost"), 0, 4, 100);
  } finally {
    fsSync.closeSync(writer);
  }
}

it.each([
  "publication",
  "replacement-before-open",
  "replacement-before-sync",
  "replacement-before-publish",
  "restore",
] as const)("preserves exact file identities above 2^53 (%s)", async (operationKind) => {
  const replace = operationKind.startsWith("replacement");
  const { directory, sourcePath, targetPath, bytes } = fixture();
  const displacedPath = path.join(directory, "displaced.sqlite");
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
            sourceIdentity: await fs.lstat(sourcePath, { bigint: true }),
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
      assertSnapshot(targetPath);
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

it.each([
  ["async", false],
  ["async", true],
  ["sync", false],
  ["sync", true],
  ["publication", false],
  ["publication", true],
] as const)(
  "verifies snapshot bytes despite FUSE timestamp drift (%s, changed bytes=%s)",
  async (mode, changeBytes) => {
    const { sourcePath, targetPath } = fixture("snapshot.bak");
    const originalOpen = fs.open.bind(fs);
    let observations = 0;
    function settleMetadata(value: BigIntStats) {
      // Model delayed metadata publication without changing the file identity.
      value.ctimeNs += BigInt(++observations) * 1_000_000_000n;
      value.birthtimeNs = value.ctimeNs;
      if (changeBytes && observations === 2) {
        // The first hash has read the original bytes; retain size and inode.
        changeSnapshotBytes(targetPath);
      }
      return value;
    }
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (mode === "async" && String(args[0]) === targetPath && args[1] === "r") {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
          if (statArgs[0]?.bigint) {
            return settleMetadata(await stat({ bigint: true }));
          }
          return await stat(...statArgs);
        });
      }
      return handle;
    });

    const operation = createVerifiedSqliteSnapshot({
      sourcePath,
      targetPath,
      afterPublish: (guard) => {
        if (mode === "publication") {
          const lstat = fsSync.lstatSync;
          vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
            if (String(args[0]) !== targetPath) {
              return lstat(...args);
            }
            const stat = lstat(...args);
            if (stat) {
              const drift = ++observations * 1_000;
              stat.ctimeMs =
                typeof stat.ctimeMs === "bigint"
                  ? stat.ctimeMs + BigInt(drift)
                  : stat.ctimeMs + drift;
              stat.birthtimeMs = stat.ctimeMs;
            }
            return stat;
          });
          guard.assertTargetUnchanged(() => {
            if (changeBytes) {
              changeSnapshotBytes(targetPath);
            }
          });
          return;
        }
        if (mode === "sync") {
          const fstat = fsSync.fstatSync.bind(fsSync);
          vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) =>
            args[1]?.bigint ? settleMetadata(fstat(args[0], { bigint: true })) : fstat(...args),
          );
        }
        guard.assertTargetMatchesExpectedContent();
      },
    });
    if (changeBytes) {
      await expect(operation).rejects.toThrow(/hash mismatch/);
    } else {
      const result = await operation;
      const bytes = fsSync.readFileSync(targetPath);
      expect(result).toMatchObject({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
      });
      assertSnapshot(targetPath);
    }
    expect(observations).toBeGreaterThan(1);
  },
);
