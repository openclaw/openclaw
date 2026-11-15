import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "@openclaw/fs-safe/durability";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

type Publisher = typeof import("@openclaw/fs-safe/durability").publishFileExclusive;
export type PublicationFixture = (
  options: Parameters<Publisher>[0],
  publish: Publisher,
) => ReturnType<Publisher>;

export function snapshotContent(bytes: Buffer) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

type SnapshotOptions = Parameters<typeof createVerifiedSqliteSnapshot>[0];

export function useSnapshotFixture(defaults: Partial<SnapshotOptions> = {}) {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  const paths = { sourcePath: "", targetPath: "", tempDir: "" };
  beforeEach(async () => {
    paths.tempDir = directories.make("openclaw-sqlite-snapshot-");
    if (process.platform === "win32") {
      paths.tempDir = path.join(paths.tempDir, "private");
      await createPrivateSqliteDirectory(paths.tempDir);
    }
    paths.sourcePath = path.join(paths.tempDir, "source.sqlite");
    paths.targetPath = path.join(paths.tempDir, "snapshot.sqlite");
    execSource("VACUUM;");
  });
  const execSource = (sql: string) => {
    using database = new (requireNodeSqlite().DatabaseSync)(paths.sourcePath);
    database.exec(sql);
  };
  const snapshot = (options: Partial<SnapshotOptions> = {}) =>
    createVerifiedSqliteSnapshot({
      sourcePath: paths.sourcePath,
      targetPath: paths.targetPath,
      ...defaults,
      ...options,
    });
  return Object.assign(paths, {
    execSource,
    snapshot,
    query(this: void, sql: string, file = paths.targetPath) {
      using database = new (requireNodeSqlite().DatabaseSync)(file, { readOnly: true });
      return database.prepare(sql).all();
    },
    async expectSnapshotSuccess(this: void, options: Partial<SnapshotOptions> = {}) {
      const receipt = await snapshot(options);
      const published = await fs.readFile(options.targetPath ?? paths.targetPath);
      expect(receipt).toEqual({
        path: options.targetPath ?? paths.targetPath,
        userVersion: 0,
        ...snapshotContent(published),
      });
      return published;
    },
    async expectSnapshotFailureWithoutTarget(
      this: void,
      pattern: RegExp,
      options: Partial<SnapshotOptions> = {},
    ) {
      await expect(snapshot(options)).rejects.toThrow(pattern);
      await expect(fs.access(options.targetPath ?? paths.targetPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  });
}

// Model the public copy receipt; native fallback selection belongs to fs-safe.
export function exclusiveCopyPublication(alterCopy?: (file: string) => Promise<void>) {
  return vi.fn<PublicationFixture>(async (options) => {
    expect(options.strategy).toBe("link-or-copy");
    await fs.copyFile(options.sourcePath, options.targetPath, fsSync.constants.COPYFILE_EXCL);
    await alterCopy?.(options.targetPath);
    await using target = await fs.open(options.targetPath, "r+");
    await target.sync();
    return {
      method: "exclusive-copy",
      identity: await target.stat(),
      exactIdentity: await target.stat({ bigint: true }),
      directorySync: await syncDirectory(path.dirname(options.targetPath)),
    };
  });
}
