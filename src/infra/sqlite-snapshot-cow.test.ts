import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { readCloneFileMetadata } from "@openclaw/fs-safe/copy";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareSqliteReadOnlyCopyInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import { defer, deferAsync } from "./sqlite-shard-lifecycle.test-support.js";
import { createVerifiedSqliteSnapshot, publishVerifiedSqliteFile } from "./sqlite-snapshot.js";
import { snapshotContent } from "./sqlite-snapshot.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

function exec(file: string, sql: string) {
  using database = new DatabaseSync(file);
  database.exec(sql);
}

function read(file: string, sql: string) {
  using database = new DatabaseSync(file, { readOnly: true });
  return database.prepare(sql).all();
}

async function expectIndependent(paths: string[], mode: "auto" | "off") {
  const stats = await Promise.all(paths.map((file) => fs.stat(file)));
  expect(new Set(stats.map((stat) => stat.ino)).size).toBe(paths.length);
  expect(stats.map((stat) => stat.nlink)).toEqual(paths.map(() => 1));
  const metadata = await readCloneFileMetadata(paths);
  // APFS exposes extent sharing; other filesystems still prove inode independence.
  if (metadata[0]) {
    const ids = metadata.map((entry) => entry?.cloneId);
    const required = paths.length === 2 ? ids.slice(1) : ids;
    expect(required.every((id) => id !== undefined && id !== 0n)).toBe(true);
    expect(new Set(ids).size).toBe(mode === "auto" ? 1 : paths.length);
  }
}

async function fixture() {
  const directory = directories.make("sqlite-cow-");
  const sourcePath = path.join(directory, "source.sqlite");
  {
    using database = new DatabaseSync(sourcePath);
    database.exec("CREATE TABLE payload(value BLOB); PRAGMA user_version=7;");
    database
      .prepare("INSERT INTO payload(rowid, value) VALUES (?, ?)")
      .run(71, Buffer.alloc(131071, 42));
  }
  const bytes = await fs.readFile(sourcePath);
  return { directory, sourcePath, bytes, content: snapshotContent(bytes) };
}

it.each(["auto", "off"] as const)("keeps synchronous snapshots independent (%s)", async (mode) => {
  const { directory, sourcePath, bytes } = await fixture();
  const previous = getFsSafeNativeConfig();
  using restore = defer(() => configureFsSafeNative(previous));
  configureFsSafeNative({ mode });
  const prepared = prepareSqliteReadOnlyLocationSyncInProcess(sourcePath, directory);
  restore[Symbol.dispose]();
  {
    using _ = defer(() => {
      expect(prepared.cleanup()).toBe(true);
    });
    expect(await fs.readFile(prepared.location)).toEqual(bytes);
    await expectIndependent([sourcePath, prepared.location], mode);
    exec(prepared.location, "DELETE FROM payload");
    expect(read(prepared.location, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(await fs.readFile(sourcePath)).toEqual(bytes);
  }
  expect(await fs.readdir(directory)).toEqual(["source.sqlite"]);
});

it.each(["auto", "off"] as const)(
  "preserves independent recovery generations (%s)",
  async (mode) => {
    const { directory, sourcePath, bytes, content } = await fixture();
    const paths = ["source", "original", "transaction"].map((name) =>
      path.join(directory, `${name}.sqlite`),
    );
    {
      const previous = getFsSafeNativeConfig();
      using _ = defer(() => configureFsSafeNative(previous));
      configureFsSafeNative({ mode });
      for (const targetPath of paths.slice(1)) {
        const snapshot = await createVerifiedSqliteSnapshot({
          sourcePath,
          targetPath,
          preserveRowIds: true,
          sourceAcquisition: {
            mode: "isolated-process",
            stagingRoot: directory,
            preserveSourceArtifacts: true,
          },
        });
        expect(snapshot).toMatchObject({ ...content, userVersion: 7 });
      }
      const restored = path.join(directory, "restored.sqlite");
      await publishVerifiedSqliteFile({
        sourcePath: paths[1]!,
        sourceIdentity: await fs.stat(paths[1]!, { bigint: true }),
        targetPath: restored,
        expectedContent: content,
        requireAtomicPublication: true,
      });
      paths.push(restored);
    }
    await expectIndependent(paths, mode);
    expect(read(paths[3]!, "SELECT rowid, length(value) AS bytes FROM payload")).toEqual([
      { rowid: 71, bytes: 131071 },
    ]);
    exec(paths[3]!, "UPDATE payload SET value='restored-write' WHERE rowid=71;");
    exec(sourcePath, "DELETE FROM payload;");
    for (const retained of paths.slice(1, 3)) {
      expect(await fs.readFile(retained)).toEqual(bytes);
    }
    await fs.unlink(paths[2]!);
    expect(await fs.readFile(paths[1]!)).toEqual(bytes);
    expect(read(paths[3]!, "SELECT value FROM payload")).toEqual([{ value: "restored-write" }]);
    expect(read(paths[3]!, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect((await fs.readdir(directory)).toSorted()).toEqual(
      ["original", "restored", "source"].map((name) => `${name}.sqlite`),
    );
  },
);

it.each(["empty WAL", "source alias"])("keeps an independent raw copy with %s", async (layout) => {
  const { directory, sourcePath } = await fixture();
  const alias = path.join(directory, "source-alias.sqlite");
  if (layout === "empty WAL") {
    exec(sourcePath, "PRAGMA journal_mode=WAL");
    await fs.writeFile(`${sourcePath}-wal`, "");
  } else {
    await fs.link(sourcePath, alias);
  }
  const bytes = await fs.readFile(sourcePath);
  const prepared = await prepareSqliteReadOnlyCopyInProcess(sourcePath, directory);
  {
    await using _ = deferAsync(async () => {
      expect(await prepared.cleanupAsync()).toBe(true);
    });
    expect(await fs.readFile(prepared.location)).toEqual(bytes);
    const output = await fs.stat(prepared.location);
    expect(output.nlink).toBe(1);
    expect(output.ino).not.toBe((await fs.stat(sourcePath)).ino);
    if (layout === "empty WAL") {
      expect((await fs.stat(`${prepared.location}-wal`)).size).toBe(0);
      const metadata = await readCloneFileMetadata([sourcePath, prepared.location]);
      if (metadata[0]) {
        expect(metadata[1]?.cloneId).toBe(metadata[0].cloneId);
      }
    } else {
      exec(prepared.location, "DELETE FROM payload");
      expect(read(prepared.location, "SELECT count(*) count FROM payload")).toEqual([{ count: 0 }]);
      expect(await fs.readFile(alias)).toEqual(bytes);
    }
    expect(await fs.readFile(sourcePath)).toEqual(bytes);
  }
  expect(await fs.readFile(sourcePath)).toEqual(bytes);
  if (layout === "empty WAL") {
    expect((await fs.stat(`${sourcePath}-wal`)).size).toBe(0);
  }
  expect((await fs.readdir(directory)).toSorted()).toEqual(
    layout === "empty WAL"
      ? ["source.sqlite", "source.sqlite-wal"]
      : ["source-alias.sqlite", "source.sqlite"],
  );
});
