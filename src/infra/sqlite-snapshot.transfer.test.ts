import { createHash } from "node:crypto";
import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "@openclaw/fs-safe/durability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";

type PublishFileExclusive = typeof import("@openclaw/fs-safe/durability").publishFileExclusive;
type PublicationFixture = (
  options: Parameters<PublishFileExclusive>[0],
  publish: PublishFileExclusive,
) => ReturnType<PublishFileExclusive>;

const durabilityTestState = vi.hoisted(() => ({
  transfer: undefined as PublicationFixture | undefined,
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    publishFileExclusive: async (...args: Parameters<typeof actual.publishFileExclusive>) => {
      if (
        durabilityTestState.transfer &&
        path.basename(path.dirname(args[0].targetPath)).startsWith(".sqlite-publish-")
      ) {
        return durabilityTestState.transfer(args[0], actual.publishFileExclusive);
      }
      return actual.publishFileExclusive(...args);
    },
  };
});

import { createVerifiedSqliteSnapshot, publishVerifiedSqliteFile } from "./sqlite-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let sourcePath: string;
let targetPath: string;
let tempDir: string;

beforeEach(async () => {
  tempDir = tempDirs.make("openclaw-sqlite-transfer-");
  if (process.platform === "win32") {
    tempDir = path.join(tempDir, "private");
    await createPrivateSqliteDirectory(tempDir);
  }
  sourcePath = path.join(tempDir, "source.sqlite");
  targetPath = path.join(tempDir, "snapshot.sqlite");
  execSource("VACUUM;");
});

afterEach(() => {
  durabilityTestState.transfer = undefined;
  vi.restoreAllMocks();
});

type SnapshotOptions = Parameters<typeof createVerifiedSqliteSnapshot>[0];

async function expectSnapshotFailureWithoutTarget(pattern: RegExp): Promise<void> {
  await expect(snapshot()).rejects.toThrow(pattern);
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function execSource(sql: string) {
  const source = new (requireNodeSqlite().DatabaseSync)(sourcePath);
  try {
    source.exec(sql);
  } finally {
    source.close();
  }
}

function query(sql: string, file = targetPath) {
  const database = new (requireNodeSqlite().DatabaseSync)(file, { readOnly: true });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function snapshot(options: Partial<SnapshotOptions> = {}) {
  return createVerifiedSqliteSnapshot({ sourcePath, targetPath, preserveRowIds: true, ...options });
}

function mockExclusiveCopyTransfer() {
  const transfer = vi.fn<PublicationFixture>(async (options) => {
    expect(options.strategy).toBe("link-or-copy");
    await fs.copyFile(options.sourcePath, options.targetPath, fsSync.constants.COPYFILE_EXCL);
    const target = await fs.open(options.targetPath, "r+");
    try {
      await target.sync();
      return {
        method: "exclusive-copy",
        identity: await target.stat(),
        exactIdentity: await target.stat({ bigint: true }),
        directorySync: await syncDirectory(path.dirname(options.targetPath)),
      };
    } finally {
      await target.close();
    }
  });
  durabilityTestState.transfer = transfer;
  return transfer;
}

function mockUnavailableBirthtime(
  mode: "zero" | "ctime",
  afterTransfer?: (stagedPath: string) => Promise<void>,
) {
  durabilityTestState.transfer = async (options, publish) => {
    const receipt = await publish(options);
    expect(receipt.method).toBe("hardlink");
    await afterTransfer?.(options.targetPath);
    return receipt;
  };
  const substituteBirthtime = (stat: Stats) => {
    // Model ctime advancing when the source link is retired, even on coarse clocks.
    stat.birthtimeMs = mode === "zero" ? 0 : stat.ctimeMs + (stat.nlink === 1 ? 1_000 : 0);
    return stat;
  };
  const fstat = fsSync.fstatSync.bind(fsSync);
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) =>
    args[1]?.bigint ? fstat(args[0], { bigint: true }) : substituteBirthtime(fstat(args[0])),
  );
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    return args[1]?.bigint
      ? await lstat(args[0], { bigint: true })
      : substituteBirthtime(await lstat(args[0]));
  });
}

describe("owned SQLite snapshot transfer", () => {
  it("publishes a snapshot in a deeply nested destination", async () => {
    let directory = tempDir;
    while (Buffer.byteLength(directory) < 431) {
      directory = path.join(
        directory,
        "nested".padEnd(Math.min(60, 430 - Buffer.byteLength(directory)), "x"),
      );
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, "snapshot.sqlite");
    execSource(
      "CREATE TABLE records(value TEXT); INSERT INTO records(rowid,value) VALUES(71,'retained');",
    );
    const original = await fs.readFile(sourcePath);

    await snapshot({ targetPath: destination });
    {
      using database = openNodeSqliteDatabase(destination, { readOnly: true });
      expect(database.prepare("SELECT rowid,value FROM records").all()).toEqual([
        { rowid: 71, value: "retained" },
      ]);
    }
    expect(await fs.readFile(sourcePath)).toEqual(original);
    expect(await fs.readdir(directory)).toEqual(["snapshot.sqlite"]);
  });

  it.each([
    { isolated: false, copyFallback: false, birthtime: "native" },
    { isolated: true, copyFallback: false, birthtime: "native" },
    { isolated: false, copyFallback: true, birthtime: "native" },
    { isolated: false, copyFallback: false, birthtime: "zero" },
    { isolated: false, copyFallback: false, birthtime: "ctime" },
  ] as const)(
    "publishes one owned private image (isolated=$isolated, copy fallback=$copyFallback, birthtime=$birthtime)",
    async ({ isolated, copyFallback, birthtime }) => {
      if (birthtime !== "native") {
        mockUnavailableBirthtime(birthtime);
      }
      const copy = copyFallback ? mockExclusiveCopyTransfer() : undefined;
      execSource(
        "CREATE TABLE records(value TEXT, payload BLOB); INSERT INTO records(rowid,value,payload) VALUES(71,'retained',zeroblob(131072));",
      );
      const original = await fs.readFile(sourcePath);
      let inspected = false;
      let preparedBytes: Buffer | undefined;
      const receipt = await snapshot({
        ...(isolated
          ? { sourceAcquisition: { mode: "isolated-process" as const, stagingRoot: tempDir } }
          : {}),
        beforePublish: async () => {
          const images: string[] = [];
          const visit = async (directory: string) => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
              const file = path.join(directory, entry.name);
              if (entry.isDirectory()) {
                await visit(file);
              } else if (
                entry.isFile() &&
                file !== sourcePath &&
                (await fs.stat(file)).size >= original.length
              ) {
                images.push(file);
              }
            }
          };
          await visit(tempDir);
          expect(images).toHaveLength(1);
          preparedBytes = await fs.readFile(images[0]!);
          inspected = true;
        },
      });
      expect(inspected).toBe(true);
      const published = await fs.readFile(targetPath);
      expect(receipt).toEqual({
        path: targetPath,
        userVersion: 0,
        sha256: createHash("sha256").update(published).digest("hex"),
        sizeBytes: published.length,
      });
      if (copy) {
        expect(copy).toHaveBeenCalledOnce();
      }
      expect((await fs.readdir(tempDir)).toSorted()).toEqual(["snapshot.sqlite", "source.sqlite"]);
      expect(await fs.readFile(targetPath)).toEqual(preparedBytes);
      expect(await fs.readFile(sourcePath)).toEqual(original);
      expect(query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(query("SELECT rowid,value,length(payload) AS bytes FROM records")).toEqual([
        { rowid: 71, value: "retained", bytes: 131072 },
      ]);
    },
  );

  it("keeps a caller-owned source independent of its published image", async () => {
    execSource("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('before');");
    const original = await fs.readFile(sourcePath);
    await publishVerifiedSqliteFile({
      sourcePath,
      sourceIdentity: await fs.stat(sourcePath, { bigint: true }),
      targetPath,
      expectedContent: {
        sha256: createHash("sha256").update(original).digest("hex"),
        sizeBytes: original.length,
      },
      beforePublish: () => {
        execSource("UPDATE records SET value='after';");
      },
    });
    expect(await fs.readFile(targetPath)).toEqual(original);
    expect(query("SELECT value FROM records", sourcePath)).toEqual([{ value: "after" }]);
  });

  it("rejects same-size byte changes during a ctime-fallback transfer", async () => {
    const original = await fs.readFile(sourcePath);
    mockUnavailableBirthtime("ctime", async (stagedPath) => {
      const bytes = await fs.readFile(stagedPath);
      bytes.write("changed", 0, "utf8");
      await fs.writeFile(stagedPath, bytes);
    });
    await expectSnapshotFailureWithoutTarget(/hash mismatch/);
    expect(await fs.readFile(sourcePath)).toEqual(original);
  });

  it.each(["allocation", "durability", "dev", "ino"] as const)(
    "refuses a failed private transfer (%s) without changing its source",
    async (failure) => {
      const original = await fs.readFile(sourcePath);
      const identityFailure = failure === "dev" || failure === "ino";
      let transferredSource: string | undefined;
      durabilityTestState.transfer = async (options, publish) => {
        if (failure === "allocation") {
          throw Object.assign(new Error("private image transfer out of space"), { code: "ENOSPC" });
        }
        const receipt = await publish(options);
        if (failure === "durability") {
          return { ...receipt, directorySync: { status: "unsupported", code: "ENOTSUP" } };
        }
        transferredSource = options.sourcePath;
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        return receipt;
      };
      if (identityFailure) {
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
          const stat = lstat(...args);
          if (stat && String(args[0]) === transferredSource && typeof stat.dev === "bigint") {
            Object.defineProperty(stat, failure, { value: 0n });
          }
          return stat;
        });
      }
      await expectSnapshotFailureWithoutTarget(
        identityFailure
          ? /source changed during transfer/
          : failure === "allocation"
            ? /out of space/
            : /staging transfer directory/,
      );
      expect(await fs.readFile(sourcePath)).toEqual(original);
      if (identityFailure) {
        expect(transferredSource).toBeDefined();
      } else {
        expect(await fs.readdir(tempDir)).toEqual(["source.sqlite"]);
      }
    },
  );
});
