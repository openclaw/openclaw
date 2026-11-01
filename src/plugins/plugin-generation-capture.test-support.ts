import fs from "node:fs";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { expect, vi, type MockInstance } from "vitest";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { writeArtifacts } from "./public-surface.test-support.js";

export type Artifact = ReturnType<typeof capturePluginGenerationArtifact>;
export type Cache = ReturnType<typeof createPluginCache>;

export const expectBytes = (filename: string, bytes: Buffer) => {
  expect(fs.readFileSync(filename)).toEqual(bytes);
};

export const readText = (filename: string) => fs.readFileSync(filename, "utf8");

export function createSdkHost(root: string, identity: string) {
  writeArtifacts(root, {
    "package.json": { name: "openclaw", exports: { "./plugin-sdk/identity": "./identity.cjs" } },
    "identity.cjs": `module.exports = ${JSON.stringify(identity)};`,
  });
  return root;
}

// Keep artifacts alive through the assertion, then release them before their owning caches.
export function captureResources() {
  const artifacts: Array<Pick<Artifact, "disposeAsync">> = [];
  const caches: Cache[] = [];
  const keep = <T extends Pick<Artifact, "disposeAsync">>(artifact: T): T => {
    artifacts.push(artifact);
    return artifact;
  };
  return {
    keep,
    cache() {
      const cache = createPluginCache();
      caches.push(cache);
      return cache;
    },
    capture(cache: Cache, root: string) {
      return keep(withPluginCache(cache, () => capturePluginGenerationArtifact(root)));
    },
    async releaseArtifacts() {
      for (const artifact of artifacts.splice(0)) {
        await artifact.disposeAsync();
      }
    },
    async [Symbol.asyncDispose]() {
      await this.releaseArtifacts();
      for (const cache of caches) {
        await retirePluginCache(cache);
      }
    },
  };
}

export function observeFileIo(filename: string, trackCopies = true) {
  const original = fs.statSync(filename);
  const { readSync, readFileSync, writeSync } = fs;
  const { copyRootFileSync, createRootFileCopyBatchSync: createBatch } = fsSafeAdvanced;
  const empty = () => ({ originalBytes: 0, capturedBytes: 0, wholeFileReads: 0, largestBuffer: 0 });
  let current: ReturnType<typeof empty> | undefined;
  let copies = new Set<string>();
  const recordCopiedFile = <T extends { fd: number }>(copied: T): T => {
    if (current) {
      const stat = fs.fstatSync(copied.fd);
      if (stat.size === original.size) {
        copies.add(`${stat.dev}:${stat.ino}`);
      }
    }
    return copied;
  };
  const spies: Pick<MockInstance, "mockRestore">[] = [
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const length = Reflect.apply(readSync, fs, args);
      const stat = fs.fstatSync(args[0]);
      if (current && stat.size === original.size) {
        const key =
          stat.dev === original.dev && stat.ino === original.ino
            ? "originalBytes"
            : "capturedBytes";
        current[key] += length;
        if (Buffer.isBuffer(args[1])) {
          current.largestBuffer = Math.max(
            current.largestBuffer,
            trackCopies ? args[1].buffer.byteLength : args[1].byteLength,
          );
        }
      }
      return length;
    }),
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      const result = readFileSync(file, options);
      if (current && Buffer.isBuffer(result) && result.length >= original.size) {
        current.wholeFileReads += 1;
      }
      return result;
    }),
  ];
  if (trackCopies) {
    spies.push(
      vi
        .spyOn(fsSafeAdvanced, "copyRootFileSync")
        .mockImplementation((options) => recordCopiedFile(copyRootFileSync(options))),
      vi.spyOn(fsSafeAdvanced, "createRootFileCopyBatchSync").mockImplementation(() => {
        const batch = createBatch();
        return { ...batch, copyFile: (options) => recordCopiedFile(batch.copyFile(options)) };
      }),
      vi.spyOn(fs, "writeSync").mockImplementation((...args) => {
        const length = Reflect.apply(writeSync, fs, args);
        recordCopiedFile({ fd: args[0] });
        return length;
      }),
    );
  }
  const begin = () => {
    const counts = (current = empty());
    copies = new Set();
    return {
      result<T>(value: T) {
        return { value, io: { ...counts, copies: copies.size } };
      },
      [Symbol.dispose]() {
        current = undefined;
      },
    };
  };
  return {
    measure<T>(run: () => T) {
      using measurement = begin();
      return measurement.result(run());
    },
    async measureAsync<T>(run: () => Promise<T>) {
      using measurement = begin();
      return measurement.result(await run());
    },
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}
