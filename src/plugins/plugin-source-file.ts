import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import { copyFileDescriptorSync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { hasErrnoCode } from "../infra/errno.js";

// Capture and native module hooks are synchronous; no read retains this scratch buffer.
const scratch = Buffer.allocUnsafe(64 * 1024);

export const pluginSourceStatIdentity = (stat: fs.BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export const pluginSourceIdentityChangedOnlyByCtime = (
  previous: string,
  current: string,
): boolean =>
  previous.slice(0, previous.lastIndexOf(":")) === current.slice(0, current.lastIndexOf(":"));

function withPluginSourceFile<T>(source: string, boundary: string, read: (fd: number) => T): T {
  const opened = openRootFileSync({
    absolutePath: source,
    rootPath: boundary,
    boundaryLabel: "plugin build source",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Cannot capture plugin source ${source}`, { cause: opened.error });
  }
  try {
    return read(opened.fd);
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function pluginSourceFileIdentity(source: string, boundary: string): string {
  return withPluginSourceFile(source, boundary, (fd) =>
    pluginSourceStatIdentity(fs.fstatSync(fd, { bigint: true })),
  );
}

export function isPluginNativeExecutable(source: string, boundary: string): boolean {
  return withPluginSourceFile(source, boundary, (fd) => {
    if (fs.readSync(fd, scratch, 0, 4, 0) !== 4) {
      return false;
    }
    const magic = scratch.readUInt32BE(0);
    return (
      scratch.readUInt16BE(0) === 0x4d5a ||
      [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(
        magic,
      )
    );
  });
}

export function copyPluginSourceFile(source: string, boundary: string, target: string): void {
  withPluginSourceFile(source, boundary, (fd) => {
    // Reopening the admitted pathname would lose the pinned inode on concurrent replacement.
    if (process.platform === "linux" || process.platform === "darwin") {
      const descriptor = `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`;
      try {
        fs.copyFileSync(descriptor, target, fs.constants.COPYFILE_FICLONE);
        return;
      } catch (error) {
        // Chroots and restricted mounts can lack descriptor paths despite a valid open file.
        if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].some((code) => hasErrnoCode(error, code))) {
          throw error;
        }
      }
    }
    const output = fs.openSync(target, "w", 0o600);
    try {
      copyFileDescriptorSync(fd, output, { maxBytes: fs.fstatSync(fd).size });
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "too-large") {
        throw new Error(
          "Plugin source changed while preparing its reload; retry after the edit finishes.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      fs.closeSync(output);
    }
  });
}

export function linkPluginSourceFile(source: string, boundary: string, target: string): void {
  withPluginSourceFile(source, boundary, (fd) => {
    const admitted = fs.fstatSync(fd, { bigint: true });
    fs.linkSync(source, target);
    const linked = fs.statSync(target, { bigint: true });
    if (linked.dev !== admitted.dev || linked.ino !== admitted.ino) {
      throw new Error("Native plugin artifact changed during admission");
    }
  });
}

export function hashPluginSourceFile(
  source: string,
  boundary: string,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
) {
  return withPluginSourceFile(source, boundary, (fd) => {
    const content = prepared ? undefined : createHash("sha256");
    const sizeBytes = prepared?.sizeBytes ?? fs.fstatSync(fd).size;
    receipt?.update(String(sizeBytes)).update("\0");
    let position = 0;
    for (;;) {
      const length = fs.readSync(
        fd,
        scratch,
        0,
        Math.min(scratch.length, sizeBytes - position + 1),
        position,
      );
      position += length;
      if (length === 0 || position > sizeBytes) {
        break;
      }
      const chunk = scratch.subarray(0, length);
      content?.update(chunk);
      receipt?.update(chunk);
    }
    if (position !== sizeBytes) {
      throw new Error(
        "Plugin source changed while preparing its reload; retry after the edit finishes.",
      );
    }
    return prepared ?? { contentHash: content!.digest("hex"), sizeBytes };
  });
}
