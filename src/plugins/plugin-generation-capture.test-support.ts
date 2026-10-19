import fs from "node:fs";
import path from "node:path";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { expect, vi } from "vitest";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";

export type Artifact = ReturnType<typeof capturePluginGenerationArtifact>;
export type Cache = ReturnType<typeof createPluginCache>;

export function writeTree(root: string, files: Record<string, string | Record<string, unknown>>) {
  for (const [name, value] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  }
}

export function expectBytes(filename: string, bytes: Buffer) {
  expect(fs.readFileSync(filename)).toEqual(bytes);
}

export function readText(filename: string) {
  return fs.readFileSync(filename, "utf8");
}

export function createSdkHost(root: string, identity: string) {
  writeTree(root, {
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
  const readSync = fs.readSync;
  const readFileSync = fs.readFileSync;
  const copyRootFileSync = fsSafeAdvanced.copyRootFileSync;
  const createBatch = fsSafeAdvanced.createRootFileCopyBatchSync;
  const writeSync = fs.writeSync;
  const empty = () => ({ originalBytes: 0, capturedBytes: 0, wholeFileReads: 0, largestBuffer: 0 });
  let current: ReturnType<typeof empty> | undefined;
  let copies = new Set<string>();
  const recordCopy = (stat: fs.Stats) => {
    if (current && stat.size === original.size) {
      copies.add(`${stat.dev}:${stat.ino}`);
    }
  };
  const recordCopiedFile = (copied: ReturnType<typeof fsSafeAdvanced.copyRootFileSync>) => {
    if (current) {
      recordCopy(fs.fstatSync(copied.fd));
    }
    return copied;
  };
  const spies = [
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const length = Reflect.apply(readSync, fs, args);
      const stat = fs.fstatSync(args[0]);
      if (current && stat.size === original.size) {
        if (stat.dev === original.dev && stat.ino === original.ino) {
          current.originalBytes += length;
        } else {
          current.capturedBytes += length;
        }
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
    ...(trackCopies
      ? [
          vi
            .spyOn(fsSafeAdvanced, "copyRootFileSync")
            .mockImplementation((options) => recordCopiedFile(copyRootFileSync(options))),
          vi.spyOn(fsSafeAdvanced, "createRootFileCopyBatchSync").mockImplementation(() => {
            const batch = createBatch();
            return {
              ...batch,
              copyFile: (options) => recordCopiedFile(batch.copyFile(options)),
            };
          }),
          vi.spyOn(fs, "writeSync").mockImplementation((...args) => {
            const length = Reflect.apply(writeSync, fs, args);
            if (current) {
              recordCopy(fs.fstatSync(args[0]));
            }
            return length;
          }),
        ]
      : []),
  ];
  return {
    measure<T>(run: () => T) {
      const counts = empty();
      current = counts;
      copies = new Set();
      try {
        return { value: run(), io: { ...counts, copies: copies.size } };
      } finally {
        current = undefined;
      }
    },
    async measureAsync<T>(run: () => Promise<T>) {
      const counts = empty();
      current = counts;
      copies = new Set();
      try {
        return { value: await run(), io: { ...counts, copies: copies.size } };
      } finally {
        current = undefined;
      }
    },
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}
