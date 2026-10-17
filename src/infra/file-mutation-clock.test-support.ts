import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { vi } from "vitest";

/** Control only ctime observations; bytes, identities and other metadata stay on the real filesystem. */
export function createFileMutationClock(
  hooks: {
    beforeLstat?: (file: fsSync.PathLike) => void;
    beforeLstatSync?: (file: fsSync.PathLike) => void;
    /** Model libuv without statx, which reports ctime as birthtime on Linux and Android. */
    birthtimeFromCtime?: boolean;
  } = {},
) {
  const times = new Map<string, bigint>();
  const observe = <T extends Stats | BigIntStats | undefined>(stat: T): T => {
    if (stat && "ctimeNs" in stat) {
      const time = times.get(`${stat.dev}:${stat.ino}`);
      if (time !== undefined) {
        stat.ctimeNs = time;
      }
      if (hooks.birthtimeFromCtime) {
        stat.birthtimeNs = stat.ctimeNs;
      }
    }
    return stat;
  };
  const lstat = fs.lstat;
  const lstatSync = fsSync.lstatSync;
  const fstatSync = fsSync.fstatSync;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    hooks.beforeLstat?.(args[0]);
    return observe(await lstat(...args));
  });
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    hooks.beforeLstatSync?.(args[0]);
    return observe(lstatSync(...args));
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => observe(fstatSync(...args)));
  return (stat: BigIntStats) => {
    const key = `${stat.dev}:${stat.ino}`;
    times.set(key, (times.get(key) ?? stat.ctimeNs) + 1_000_000_000n);
  };
}
