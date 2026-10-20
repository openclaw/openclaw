import { createHash } from "node:crypto";
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
import { createVerifiedSqliteSnapshot, publishVerifiedSqliteFile } from "./sqlite-snapshot.js";
import { readDatabasePathIdentity } from "./sqlite-worker-identity.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

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
  const content = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
  return { directory, sourcePath, bytes, content };
}

it.each(["auto", "off"] as const)(
  "keeps synchronous artifact-preserving snapshots independent with native copying %s",
  async (mode) => {
    const { directory, sourcePath, bytes } = await fixture();
    const previous = getFsSafeNativeConfig();
    try {
      configureFsSafeNative({ mode });
      const prepared = prepareSqliteReadOnlyLocationSyncInProcess(sourcePath, directory);
      configureFsSafeNative(previous);
      try {
        expect(await fs.readFile(prepared.location)).toEqual(bytes);
        const [source, copy] = await Promise.all(
          [sourcePath, prepared.location].map((file) => fs.stat(file)),
        );
        expect(copy!.ino).not.toBe(source!.ino);
        expect(copy!.nlink).toBe(1);
        const metadata = await readCloneFileMetadata([sourcePath, prepared.location]);
        if (metadata[0]) {
          expect(metadata[1]?.cloneId).not.toBe(0n);
          expect(metadata[1]?.cloneId === metadata[0].cloneId).toBe(mode === "auto");
        }
        {
          using snapshot = new DatabaseSync(prepared.location);
          snapshot.exec("DELETE FROM payload");
          expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        }
        expect(await fs.readFile(sourcePath)).toEqual(bytes);
      } finally {
        expect(prepared.cleanup()).toBe(true);
      }
      expect(await fs.readdir(directory)).toEqual(["source.sqlite"]);
    } finally {
      configureFsSafeNative(previous);
    }
  },
);

it.each(["auto", "off"] as const)(
  "preserves independent recovery generations with native copying %s",
  async (mode) => {
    const { directory, sourcePath, bytes, content } = await fixture();
    const paths = [
      sourcePath,
      path.join(directory, "original.sqlite"),
      path.join(directory, "transaction.sqlite"),
    ];
    const previous = getFsSafeNativeConfig();
    try {
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
    } finally {
      configureFsSafeNative(previous);
    }
    const stats = await Promise.all(paths.map((file) => fs.stat(file)));
    expect(new Set(stats.map((stat) => stat.ino)).size).toBe(paths.length);
    expect(stats.map((stat) => stat.nlink)).toEqual(paths.map(() => 1));
    const metadata = await readCloneFileMetadata(paths);
    // APFS exposes extent sharing; other filesystems still exercise byte and lifetime contracts.
    if (metadata[0]) {
      const cloneIds = metadata.map((entry) => entry?.cloneId);
      expect(cloneIds.every((id) => id !== undefined && id !== 0n)).toBe(true);
      expect(new Set(cloneIds).size).toBe(mode === "auto" ? 1 : paths.length);
    }
    {
      using restored = new DatabaseSync(paths[3]!);
      expect(restored.prepare("SELECT rowid, length(value) AS bytes FROM payload").all()).toEqual([
        { rowid: 71, bytes: 131071 },
      ]);
      restored.exec("UPDATE payload SET value='restored-write' WHERE rowid=71;");
    }
    {
      using source = new DatabaseSync(sourcePath);
      source.exec("DELETE FROM payload;");
    }
    for (const retained of paths.slice(1, 3)) {
      expect(await fs.readFile(retained)).toEqual(bytes);
    }
    await fs.unlink(paths[2]!);
    expect(await fs.readFile(paths[1]!)).toEqual(bytes);
    {
      using reopened = new DatabaseSync(paths[3]!, { readOnly: true });
      expect(reopened.prepare("SELECT value FROM payload").get()).toEqual({
        value: "restored-write",
      });
      expect(reopened.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    }
    expect((await fs.readdir(directory)).toSorted()).toEqual([
      "original.sqlite",
      "restored.sqlite",
      "source.sqlite",
    ]);
  },
);

it("rejects an identical replacement for an admitted raw source without retaining scratch", async () => {
  const { directory, sourcePath, bytes } = await fixture();
  const identity = await readDatabasePathIdentity(sourcePath);
  const original = path.join(directory, "displaced.sqlite");
  await fs.rename(sourcePath, original);
  await fs.writeFile(sourcePath, bytes);
  await expect(prepareSqliteReadOnlyCopyInProcess(sourcePath, directory, identity)).rejects.toThrow(
    "file identity changed",
  );
  expect(await fs.readFile(sourcePath)).toEqual(bytes);
  expect(await fs.readFile(original)).toEqual(bytes);
  expect((await fs.readdir(directory)).toSorted()).toEqual(["displaced.sqlite", "source.sqlite"]);
});

it.each(["empty WAL", "source alias"])("keeps an independent raw copy with %s", async (layout) => {
  const { directory, sourcePath } = await fixture();
  const alias = path.join(directory, "source-alias.sqlite");
  if (layout === "empty WAL") {
    {
      using writer = new DatabaseSync(sourcePath);
      writer.exec("PRAGMA journal_mode=WAL");
    }
    await fs.writeFile(`${sourcePath}-wal`, "");
  } else {
    await fs.link(sourcePath, alias);
  }
  const bytes = await fs.readFile(sourcePath);
  const prepared = await prepareSqliteReadOnlyCopyInProcess(sourcePath, directory);
  try {
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
      {
        using writer = new DatabaseSync(prepared.location);
        writer.exec("DELETE FROM payload");
        expect(writer.prepare("SELECT count(*) AS count FROM payload").get()).toEqual({ count: 0 });
      }
      expect(await fs.readFile(alias)).toEqual(bytes);
    }
    expect(await fs.readFile(sourcePath)).toEqual(bytes);
  } finally {
    expect(await prepared.cleanupAsync()).toBe(true);
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
