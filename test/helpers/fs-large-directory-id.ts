import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { vi } from "vitest";

/** Model filesystem IDs that cannot round-trip through numeric Node Stats. */
export function mockLargeDirectoryId(directoryPath: string): { mockRestore(): void } {
  const directory = fs.lstatSync(directoryPath, { bigint: true });
  const largeInode = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
  const lstat = fs.lstatSync;
  const statSync = fs.statSync;
  const fstat = fs.fstatSync;
  const lstatAsync = fsPromises.lstat;
  const withLargeIdentity = <T extends fs.Stats | fs.BigIntStats | undefined>(stat: T): T => {
    if (
      stat?.isDirectory() &&
      (typeof stat.dev === "bigint"
        ? stat.dev === directory.dev
        : stat.dev === Number(directory.dev)) &&
      (typeof stat.ino === "bigint"
        ? stat.ino === directory.ino
        : stat.ino === Number(directory.ino))
    ) {
      stat.ino = typeof stat.ino === "bigint" ? largeInode : Number(largeInode);
    }
    return stat;
  };
  const spies = [
    vi.spyOn(fs, "statSync").mockImplementation((...args) => withLargeIdentity(statSync(...args))),
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => withLargeIdentity(lstat(...args))),
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) => withLargeIdentity(fstat(...args))),
    vi
      .spyOn(fsPromises, "lstat")
      .mockImplementation(async (...args) => withLargeIdentity(await lstatAsync(...args))),
  ];
  return {
    mockRestore() {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}
