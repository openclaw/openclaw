import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import type { HeaderData } from "tar";
import { hasErrnoCode } from "./errno.js";

/** Open sources before emitting headers so a vanished name cannot leave a partial entry. */
export async function* walkBackupTar(params: {
  tar: Pick<typeof import("tar"), "Header" | "Pax">;
  paths: readonly string[];
  skip: (sourcePath: string) => boolean;
  filter: (sourcePath: string, stat: Stats) => boolean;
  onEntry: (sourcePath: string, header: HeaderData) => void;
  onVanished: (sourcePath: string) => void;
  onProgress: (sourcePath: string, bytes?: number) => void;
}): AsyncGenerator<Buffer> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  type Directory = { sourcePath: string; stat: Stats };
  const assertDirectory = async ({ sourcePath, stat }: Directory) => {
    const current = await fs.lstat(sourcePath);
    if (!current.isDirectory() || !sameFileIdentity(stat, current)) {
      throw new Error(`Backup directory changed during traversal: ${sourcePath}`);
    }
  };
  async function* visit(sourcePath: string, parent?: Directory): AsyncGenerator<Buffer> {
    params.onProgress(sourcePath);
    if (params.skip(sourcePath)) {
      return;
    }
    let handle: FileHandle | undefined;
    let stat: Stats;
    let names: string[] | undefined;
    let linkpath: string | undefined;
    try {
      try {
        stat = await fs.lstat(sourcePath);
        if (parent) {
          await assertDirectory(parent);
        }
        if (!params.filter(sourcePath, stat)) {
          return;
        }
        if (stat.isDirectory()) {
          names = await fs.readdir(sourcePath);
          await assertDirectory({ sourcePath, stat });
        } else if (stat.isSymbolicLink()) {
          linkpath = await fs.readlink(sourcePath);
          // Match tar's Windows reader before the manifest and header share this target.
          if (process.platform === "win32") {
            linkpath = linkpath.replaceAll("\\", "/");
          }
        } else if (stat.isFile()) {
          handle = await fs.open(sourcePath, constants.O_RDONLY | noFollow);
          const opened = await handle.stat();
          if (!opened.isFile()) {
            throw new Error(`Backup source changed while opening: ${sourcePath}`);
          }
          // The kernel binds a no-follow open; later renames cannot invalidate its bytes.
          // Without that support, bind the descriptor to a regular-file observation.
          if (!noFollow) {
            const current = await fs.lstat(sourcePath).catch((error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return undefined;
              }
              throw error;
            });
            if (current?.isSymbolicLink()) {
              throw new Error(`Backup source became a symbolic link while opening: ${sourcePath}`);
            }
            if (
              !sameFileIdentity(stat, opened) &&
              (!current?.isFile() || !sameFileIdentity(current, opened))
            ) {
              throw new Error(`Backup source identity changed while opening: ${sourcePath}`);
            }
          }
          stat = opened;
        } else {
          return;
        }
        // Recheck after pathname I/O, before headers or bytes can escape the iterator.
        if (parent) {
          await assertDirectory(parent);
        }
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        params.onVanished(sourcePath);
        return;
      }
      const directory = stat.isDirectory();
      let mode = ((stat.mode & 0o7777) | 0o600) & ~0o22;
      if (directory) {
        mode |= (mode & 0o444) >> 2;
      }
      const header: HeaderData = {
        path: sourcePath,
        type: directory ? "Directory" : stat.isSymbolicLink() ? "SymbolicLink" : "File",
        mode,
        size: handle ? stat.size : 0,
        mtime: directory ? undefined : stat.mtime,
        linkpath,
      };
      params.onEntry(sourcePath, header);
      if (directory) {
        header.path += "/";
      }
      const block = Buffer.alloc(512);
      if (new params.tar.Header(header).encode(block)) {
        yield new params.tar.Pax(header).encode();
      }
      yield block;
      if (handle) {
        let position = 0;
        while (position < stat.size) {
          const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, stat.size - position));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) {
            throw Object.assign(new Error("encountered unexpected EOF"), {
              code: "EOF",
              path: sourcePath,
            });
          }
          position += bytesRead;
          params.onProgress(sourcePath, bytesRead);
          yield buffer.subarray(0, bytesRead);
        }
        const padding = (512 - (stat.size % 512)) % 512;
        if (padding) {
          yield Buffer.alloc(padding);
        }
      }
    } finally {
      await handle?.close();
    }
    for (const name of names ?? []) {
      yield* visit(path.join(sourcePath, name), { sourcePath, stat });
    }
    if (names && !parent) {
      await assertDirectory({ sourcePath, stat });
    }
  }
  for (const sourcePath of params.paths) {
    yield* visit(sourcePath);
  }
  yield Buffer.alloc(1024);
}
