import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as logger from "../logging/logger.js";
import { listDirectoryTreeStrict } from "./directory-walk.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readMigrationArtifactIdentity,
  type MigrationArtifactVerification,
} from "./session-sqlite-migration-artifact.js";
import { cleanupSnapshotOperations } from "./sqlite-readonly-location-cleanup.js";
import * as retirement from "./sqlite-snapshot-retirement.js";
import {
  exclusiveCopyPublication,
  snapshotContent,
  useSnapshotFixture,
  type PublicationFixture,
} from "./sqlite-snapshot.test-support.js";

const durabilityTestState = vi.hoisted(() => ({
  transfer: undefined as PublicationFixture | undefined,
  hashedBytes: 0,
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    sha256File: async (...args: Parameters<typeof actual.sha256File>) => {
      const result = await actual.sha256File(...args);
      durabilityTestState.hashedBytes += result.bytes;
      return result;
    },
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

import { publishVerifiedSqliteFile } from "./sqlite-snapshot.js";

let sourcePath: string;
let targetPath: string;
let tempDir: string;
const fixture = useSnapshotFixture({ preserveRowIds: true });
const { execSource, query, snapshot, expectSnapshotFailureWithoutTarget } = fixture;
beforeEach(() => {
  ({ tempDir, sourcePath, targetPath } = fixture);
});

afterEach(async () => {
  durabilityTestState.transfer = undefined;
  durabilityTestState.hashedBytes = 0;
  vi.restoreAllMocks();
  await cleanupSnapshotOperations();
});

function mockExclusiveCopyTransfer() {
  const transfer = exclusiveCopyPublication();
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
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) =>
    args[1]?.bigint
      ? await lstat(args[0], { bigint: true })
      : substituteBirthtime(await lstat(args[0])),
  );
}

it("closes the published image before removing its NFS staging directory", async () => {
  const open = fs.open;
  let targetOpen = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === targetPath && args[1] === "r") {
      targetOpen = true;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        targetOpen = false;
      });
    }
    return handle;
  });
  const rmdir = fs.rmdir;
  vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
    if (path.basename(String(args[0])).startsWith(".sqlite-publish-") && targetOpen) {
      throw Object.assign(new Error("NFS silly rename keeps the directory nonempty"), {
        code: "ENOTEMPTY",
      });
    }
    return rmdir(...args);
  });
  await fixture.expectSnapshotSuccess();
  expect((await fs.readdir(tempDir)).toSorted()).toEqual(["snapshot.sqlite", "source.sqlite"]);
});

it.each(["ENOTEMPTY", "EBUSY"])(
  "keeps a verified snapshot when NFS staging cleanup returns %s",
  async (code) => {
    const warn = vi.fn();
    const childLogger = logger.getChildLogger;
    vi.spyOn(logger, "getChildLogger").mockImplementation((bindings, options) =>
      bindings?.subsystem === "infra/sqlite-snapshot"
        ? ({ warn } as unknown as ReturnType<typeof childLogger>)
        : childLogger(bindings, options),
    );
    const unlink = fs.unlink;
    vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
      await unlink(...args);
      const directory = path.dirname(String(args[0]));
      if (path.basename(directory).startsWith(".sqlite-publish-")) {
        await fs.writeFile(path.join(directory, ".nfs00000001"), "");
      }
    });
    const rmdir = fs.rmdir;
    let deferredDirectory = "";
    vi.spyOn(fs, "rmdir").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])).startsWith(".sqlite-publish-")) {
        deferredDirectory = String(args[0]);
        throw Object.assign(new Error("NFS open file pending release"), { code });
      }
      return rmdir(...args);
    });
    await fixture.expectSnapshotSuccess();
    expect(await fs.readdir(deferredDirectory)).toEqual([".nfs00000001"]);
    expect(warn).toHaveBeenCalledWith(
      { path: deferredDirectory, errorCode: code },
      expect.stringContaining("cleanup deferred"),
    );
    expect(query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  },
);

it.each([
  { phase: "directory", code: "EBUSY", succeeds: true },
  { phase: "directory", code: "ENOTEMPTY", succeeds: true },
  { phase: "directory", code: "EACCES", succeeds: false },
  { phase: "directory", code: "EPERM", succeeds: false },
  { phase: "directory", code: "EIO", succeeds: false },
  { phase: "payload", code: "EBUSY", succeeds: false },
  { phase: "retirement", code: "EBUSY", succeeds: false },
] as const)(
  "settles a verified backup after $phase cleanup returns $code",
  async ({ phase, code, succeeds }) => {
    const original = await fs.readFile(sourcePath);
    let injected = false;
    const failure = Object.assign(new Error(`${phase} cleanup refused: ${code}`), {
      code,
      syscall: phase === "payload" ? "unlink" : "rmdir",
    });
    if (phase === "retirement") {
      vi.spyOn(retirement, "beginSqliteSnapshotRetirement").mockImplementation(() => {
        injected = true;
        throw failure;
      });
    }
    const remove = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      const target = String(args[0]);
      if (
        phase !== "retirement" &&
        target.includes("openclaw-sqlite-readonly-v2-") &&
        (phase === "directory"
          ? path.basename(target).startsWith("openclaw-sqlite-readonly-v2-")
          : path.basename(target) === "database.sqlite.partial")
      ) {
        injected = true;
        throw failure;
      }
      return remove(...args);
    });
    const capture = snapshot({
      sourceAcquisition: { mode: "isolated-process", stagingRoot: tempDir },
      afterPublish: () => {
        if (phase === "payload") {
          const directory = fsSync
            .readdirSync(tempDir)
            .find((name) => name.startsWith("openclaw-sqlite-readonly-v2-"));
          assert(directory);
          fsSync.writeFileSync(
            path.join(tempDir, directory, "database.sqlite.partial"),
            "retained private payload",
          );
        }
      },
    });
    if (succeeds) {
      await expect(capture).resolves.toMatchObject({ path: targetPath });
    } else {
      await expect(capture).rejects.toMatchObject({ cause: failure });
    }
    expect(injected).toBe(true);
    expect(await fs.readFile(sourcePath)).toEqual(original);
    expect(query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  },
);

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

it.each(["native", "isolated", "copy", "zero", "ctime"] as const)(
  "publishes one owned private image (%s)",
  async (mode) => {
    if (mode === "zero" || mode === "ctime") {
      mockUnavailableBirthtime(mode);
    }
    const copy = mode === "copy" ? mockExclusiveCopyTransfer() : undefined;
    execSource(
      "CREATE TABLE records(value TEXT, payload BLOB); INSERT INTO records(rowid,value,payload) VALUES(71,'retained',zeroblob(131072));",
    );
    const original = await fs.readFile(sourcePath);
    let preparedBytes: Buffer | undefined;
    const receipt = await snapshot({
      sourceAcquisition:
        mode === "isolated" ? { mode: "isolated-process", stagingRoot: tempDir } : undefined,
      beforePublish: async () => {
        const images: string[] = [];
        for (const entry of (await listDirectoryTreeStrict(tempDir)).map(
          (walkEntry) => walkEntry.dirent,
        )) {
          const file = path.join(entry.parentPath, entry.name);
          if (
            entry.isFile() &&
            file !== sourcePath &&
            (await fs.stat(file)).size >= original.length
          ) {
            images.push(file);
          }
        }
        expect(images).toHaveLength(1);
        preparedBytes = await fs.readFile(images[0]!);
      },
    });
    const published = await fs.readFile(targetPath);
    expect(receipt).toEqual({
      path: targetPath,
      userVersion: 0,
      ...snapshotContent(published),
    });
    // Only a distinct staged copy adds a digest pass to capture and final publication.
    expect(durabilityTestState.hashedBytes).toBe((copy ? 3 : 2) * receipt.sizeBytes);
    if (copy) {
      expect(copy).toHaveBeenCalledOnce();
    }
    expect((await fs.readdir(tempDir)).toSorted()).toEqual(["snapshot.sqlite", "source.sqlite"]);
    assert(preparedBytes?.equals(await fs.readFile(targetPath)), targetPath);
    assert(original.equals(await fs.readFile(sourcePath)), sourcePath);
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
    expectedContent: snapshotContent(original),
    beforePublish: () => execSource("UPDATE records SET value='after';"),
  });
  expect(await fs.readFile(targetPath)).toEqual(original);
  expect(query("SELECT value FROM records", sourcePath)).toEqual([{ value: "after" }]);
});

it("does not bind an earlier publication hash to metadata changed by its final callback", async () => {
  const original = await fs.readFile(sourcePath);
  const verification: MigrationArtifactVerification = new Map();
  await publishVerifiedSqliteFile({
    sourcePath,
    sourceIdentity: await fs.stat(sourcePath, { bigint: true }),
    targetPath,
    expectedContent: snapshotContent(original),
    afterPublish: (guard) => {
      const verified = guard.assertTargetUnchanged(() => {
        fsSync.utimesSync(targetPath, 1_700_000_000, 1_700_000_000);
      });
      verification.set(`${verified.stat.dev}:${verified.stat.ino}`, verified);
    },
  });
  let readBytes = 0;
  const read = fsSync.readSync;
  using _ = vi.spyOn(fsSync, "readSync").mockImplementation((...args: Parameters<typeof read>) => {
    const count = read(...args);
    readBytes += count;
    return count;
  });
  const identity = readMigrationArtifactIdentity(targetPath, 1n, undefined, verification);
  expect(identity).toMatchObject({
    sha256: snapshotContent(original).sha256,
    size: original.length,
  });
  expect(readBytes).toBe(original.length);
});

it("rejects same-size byte changes during a ctime-fallback transfer", async () => {
  execSource("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('retained');");
  const original = await fs.readFile(sourcePath);
  mockUnavailableBirthtime("ctime", async (stagedPath) => {
    const bytes = await fs.readFile(stagedPath);
    const offset = bytes.indexOf("retained");
    expect(offset).toBeGreaterThanOrEqual(0);
    bytes.write("modified", offset, "utf8");
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
