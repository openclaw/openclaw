import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

export function interceptStagedFileSync(parent: string, failure: Error, enabled = true) {
  const handles: Array<{ fd: number; dev: bigint; ino: bigint }> = [];
  const isStaged = (identity: fs.BigIntStats) =>
    enabled &&
    identity.isFile() &&
    fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".openclaw-shim-stage-"))
      .some(({ name }) =>
        fs.readdirSync(path.join(parent, name)).some((entry) => {
          const current = fs.lstatSync(path.join(parent, name, entry), { bigint: true });
          return current.isFile() && current.dev === identity.dev && current.ino === identity.ino;
        }),
      );
  const refuse = (fd: number) => {
    const identity = fs.fstatSync(fd, { bigint: true });
    if (isStaged(identity)) {
      handles.push({ fd, dev: identity.dev, ino: identity.ino });
      throw failure;
    }
  };
  const open = fsp.open;
  const openSpy = vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      refuse(handle.fd);
      await sync();
    });
    return handle;
  });
  const fsync = fs.fsync;
  const fsyncSpy = vi.spyOn(fs, "fsync").mockImplementation((fd, callback) => {
    try {
      refuse(fd);
    } catch (error) {
      queueMicrotask(() => callback(error as NodeJS.ErrnoException));
      return;
    }
    fsync(fd, callback);
  });
  const fsyncSync = fs.fsyncSync;
  const fsyncSyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    refuse(fd);
    fsyncSync(fd);
  });
  return {
    handles,
    get refused() {
      return handles.length;
    },
    restore() {
      openSpy.mockRestore();
      fsyncSpy.mockRestore();
      fsyncSyncSpy.mockRestore();
    },
  };
}
