import nodeFs, { Dir } from "node:fs";
import fs from "node:fs/promises";
import { expect, vi } from "vitest";

export function installUnknownDirentFixture(rawDirectory: Buffer, name: Buffer) {
  const lstat = vi.spyOn(nodeFs, "lstatSync");
  const realOpen = fs.opendir;
  const usesNodeDirHandle = !process.versions.bun;
  const names: unknown[] = [];
  let opened: Dir | undefined;
  let reads = 0;
  let classifiedEntries = 0;
  let iteratorExhausted = false;
  const close = vi.fn((request: { oncomplete: (error: Error | null) => void }) => {
    request.oncomplete(null);
  });
  vi.spyOn(fs, "opendir").mockImplementation(async (directoryPath, options) => {
    if (!Buffer.isBuffer(directoryPath) || !directoryPath.equals(rawDirectory)) {
      return await realOpen(directoryPath, options);
    }
    expect(options).toEqual({ encoding: "buffer" });
    if (usesNodeDirHandle) {
      // Retain Node's native UV_DIRENT_UNKNOWN fallback, including exact-byte
      // lstat and handle closure; Bun does not implement this private handle ABI.
      const handle = {
        read(
          encoding: string,
          _bufferSize: number,
          request: {
            oncomplete: (error: Error | null, entries: (Buffer | string | number)[] | null) => void;
          },
        ) {
          if (encoding !== "buffer" && !Buffer.isEncoding(encoding)) {
            throw new Error(`Unexpected directory encoding: ${encoding}`);
          }
          request.oncomplete(
            null,
            reads++ === 0 ? [encoding === "buffer" ? name : name.toString(encoding), 0] : null,
          );
        },
        close,
      };
      // Dir's public declaration omits Node's runtime constructor arguments.
      const directory: unknown = Reflect.construct(Dir, [handle, directoryPath, options]);
      if (!(directory instanceof Dir)) {
        throw new Error("Expected a real Node directory");
      }
      opened = directory;
      return directory;
    }
    // Model an unknown-type dependency fallback on Bun's public iterator.
    // Names and stat paths come from the actual API, not expected fixture bytes.
    const directory = await realOpen(directoryPath, options);
    opened = directory;
    const entries = directory[Symbol.asyncIterator].bind(directory);
    vi.spyOn(directory, Symbol.asyncIterator).mockImplementation(async function* () {
      for await (const entry of entries()) {
        names.push(entry.name);
        const entryName = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
        const entryPath = Buffer.concat([directoryPath, Buffer.from("/"), entryName]);
        const stat = nodeFs.lstatSync(entryPath);
        Object.assign(entry, {
          isBlockDevice: stat.isBlockDevice.bind(stat),
          isCharacterDevice: stat.isCharacterDevice.bind(stat),
          isDirectory: stat.isDirectory.bind(stat),
          isFIFO: stat.isFIFO.bind(stat),
          isFile: stat.isFile.bind(stat),
          isSocket: stat.isSocket.bind(stat),
          isSymbolicLink: stat.isSymbolicLink.bind(stat),
        });
        classifiedEntries++;
        yield entry;
      }
      iteratorExhausted = true;
      return undefined;
    });
    return directory;
  });
  return {
    expectConsumed(expectedChild: Buffer) {
      expect(lstat).toHaveBeenCalledWith(expectedChild);
      if (usesNodeDirHandle) {
        expect(reads).toBe(2);
        expect(close).toHaveBeenCalledOnce();
      } else {
        expect(names).toEqual([name]);
        expect(classifiedEntries).toBe(1);
        expect(iteratorExhausted).toBe(true);
      }
      expect(opened).toBeDefined();
      expect(() => opened!.readSync()).toThrow();
    },
  };
}
