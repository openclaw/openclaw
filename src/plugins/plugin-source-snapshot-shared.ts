import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { createRootFileOpenBatchSync } from "@openclaw/fs-safe/advanced";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import type { PluginFrozenSourceSnapshot } from "./plugin-generation-source.types.js";
import { pluginSourceStatIdentity } from "./plugin-source-file.js";
import type {
  PluginSourceSnapshotEntry,
  PluginSourceSnapshotManifest,
} from "./plugin-source-snapshot-artifact.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";

type SourceLease = PluginFrozenSourceSnapshot & {
  assertCurrent(): void;
  release(): void;
  releaseAsync(): Promise<void>;
};
export type PluginSourceSnapshotScrubReport = {
  done: boolean;
  entries: number;
  files: number;
  bytes: number;
  totalEntries: number;
  totalFiles: number;
  totalBytes: number;
  elapsedMs: number;
  totalElapsedMs: number;
};
export type PluginSourceSnapshotScrub = {
  step(options: {
    maxFiles: number;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<PluginSourceSnapshotScrubReport>;
  dispose(): Promise<void>;
};
export type AcquiredPluginSharedSourceSnapshot = SourceLease & {
  readonly payloadRoot: string;
  readonly stateDir: string;
  readonly descriptor: PluginSourceSnapshotDescriptor;
  readonly entries: ReadonlyMap<string, PluginSourceSnapshotEntry>;
  readonly resolution: ReadonlyMap<string, string>;
  readonly configuration: ReadonlyMap<string, string>;
  assertMemberPath(filename: string): void;
  readVerifiedFile(filename: string): Buffer;
  retain(): AcquiredPluginSharedSourceSnapshot;
  createScrub(): PluginSourceSnapshotScrub;
};
type FileEntry = Extract<PluginSourceSnapshotEntry, { kind: "file" }>;
type Invalid = (detail: string) => never;

/** This view owns authenticated facts; every lease has independent physical reader custody. */
export function createPluginSharedSnapshotView(params: {
  source: SourceLease;
  manifest: PluginSourceSnapshotManifest;
  descriptor: PluginSourceSnapshotDescriptor;
  stateDir: string;
  assertCurrent(): void;
  retain(): void;
  release(): void;
  fail: Invalid;
}): AcquiredPluginSharedSourceSnapshot {
  const fail: Invalid = params.fail;
  const manifest = params.manifest;
  const payloadRoot = path.join(params.descriptor.artifact.path, "payload");
  const entries = new Map<string, PluginSourceSnapshotEntry>(
    manifest.entries.map((entry) => {
      const absolute = path.join(payloadRoot, entry.path);
      if (!isPathInside(payloadRoot, absolute) || absolute === payloadRoot) {
        fail(`invalid manifest member: ${entry.path}`);
      }
      return [
        absolute,
        Object.freeze({
          ...entry,
          path: absolute,
          ...(entry.kind === "link" ? { target: path.join(payloadRoot, entry.target) } : {}),
        }),
      ] as const;
    }),
  );
  const resolution = new Map(
    Object.entries(manifest.resolution ?? {}).map(([directory, text]) => [
      path.join(payloadRoot, directory),
      text,
    ]),
  );
  const configuration = new Map(
    Object.entries(manifest.configuration ?? {}).map(([filename, text]) => [
      path.join(payloadRoot, filename),
      text,
    ]),
  );
  const opened = createRootFileOpenBatchSync();
  let leases = 0;
  const owner = (stat: fs.BigIntStats) =>
    `${stat.dev}:${stat.ino}:${stat.uid}:${stat.gid}:${stat.mode}`;
  const assertStat = (filename: string, entry: PluginSourceSnapshotEntry, stat: fs.BigIntStats) => {
    const correctType =
      entry.kind === "file"
        ? stat.isFile()
        : entry.kind === "directory"
          ? stat.isDirectory()
          : stat.isSymbolicLink();
    if (
      !correctType ||
      pluginSourceStatIdentity(stat) !== entry.identity ||
      (entry.owner !== undefined && owner(stat) !== entry.owner) ||
      (process.getuid && stat.uid !== BigInt(process.getuid())) ||
      (entry.kind === "file" && stat.nlink !== 1n)
    ) {
      fail(`snapshot member identity, type, owner or permissions changed: ${filename}`);
    }
  };
  const checked = <T>(filename: string, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "PLUGIN_SOURCE_SNAPSHOT_INVALID"
      ) {
        throw error;
      }
      return fail(`snapshot member failed validation: ${filename}: ${String(error)}`);
    }
  };
  const resolveMember = (
    filename: string,
  ): { filename: string; entry: PluginSourceSnapshotEntry } =>
    checked(filename, () => {
      let target = path.resolve(filename);
      let links = 0;
      if (!isPathInside(payloadRoot, target) || target === payloadRoot) {
        fail(`module leaves snapshot: ${filename}`);
      }
      for (;;) {
        let current = payloadRoot;
        const parts = path.relative(payloadRoot, target).split(path.sep);
        let redirected = false;
        for (let index = 0; index < parts.length; index++) {
          current = path.join(current, parts[index]!);
          const entry = entries.get(current);
          if (!entry) {
            fail(`module is outside snapshot membership: ${filename}`);
          }
          assertStat(current, entry, fs.lstatSync(current, { bigint: true }));
          if (entry.kind === "link") {
            if (++links > 40 || !isPathInside(payloadRoot, entry.target)) {
              fail(`invalid snapshot link: ${current}`);
            }
            const raw = path.resolve(path.dirname(current), fs.readlinkSync(current));
            const observed =
              process.platform === "win32" ? normalizeWindowsPathPreservingCase(raw) : raw;
            if (observed !== entry.target) {
              fail(`snapshot dependency link retargeted: ${current}`);
            }
            assertStat(current, entry, fs.lstatSync(current, { bigint: true }));
            target = path.join(entry.target, ...parts.slice(index + 1));
            redirected = true;
            break;
          }
          if (index < parts.length - 1 && entry.kind !== "directory") {
            fail(`snapshot parent is not a directory: ${current}`);
          }
          if (index === parts.length - 1) {
            return { filename: current, entry };
          }
        }
        if (!redirected) {
          return fail(`invalid snapshot member: ${filename}`);
        }
      }
    });
  const openVerified = (filename: string) => {
    const selected = resolveMember(filename);
    if (selected.entry.kind !== "file") {
      fail(`snapshot module is not a file: ${filename}`);
    }
    const pinned = opened.openFile({
      absolutePath: selected.filename,
      rootPath: payloadRoot,
      boundaryLabel: "plugin snapshot module",
      rejectHardlinks: true,
    });
    if (!pinned.ok) {
      fail(`snapshot module failed guarded open: ${filename}`);
    }
    try {
      assertStat(selected.filename, selected.entry, fs.fstatSync(pinned.fd, { bigint: true }));
    } catch (error) {
      fs.closeSync(pinned.fd);
      throw error;
    }
    // SAFETY: The file-kind check above rejected non-file entries before guarded open.
    return { filename: selected.filename, entry: selected.entry as FileEntry, fd: pinned.fd };
  };
  const readVerifiedFile = (filename: string): Buffer =>
    checked(filename, () => {
      const file = openVerified(filename);
      try {
        const bytes = readFileDescriptorBoundedSync(file.fd, file.entry.sizeBytes);
        if (
          bytes.length !== file.entry.sizeBytes ||
          createHash("sha256").update(bytes).digest("hex") !== file.entry.contentHash
        ) {
          fail(`snapshot module bytes changed: ${filename}`);
        }
        assertStat(file.filename, file.entry, fs.fstatSync(file.fd, { bigint: true }));
        resolveMember(filename);
        return bytes;
      } finally {
        fs.closeSync(file.fd);
      }
    });
  const createLease = (): AcquiredPluginSharedSourceSnapshot => {
    leases++;
    let released = false;
    const assertCurrent = () => {
      if (released) {
        fail("snapshot reader has been released");
      }
      params.assertCurrent();
    };
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      params.release();
      if (--leases === 0) {
        opened[Symbol.dispose]();
      }
    };
    const lease: AcquiredPluginSharedSourceSnapshot = {
      ...params.source,
      payloadRoot,
      stateDir: params.stateDir,
      descriptor: params.descriptor,
      entries,
      resolution,
      configuration,
      assertCurrent,
      release,
      releaseAsync: async () => release(),
      assertMemberPath(filename) {
        assertCurrent();
        resolveMember(filename);
      },
      readVerifiedFile(filename) {
        assertCurrent();
        return readVerifiedFile(filename);
      },
      retain() {
        assertCurrent();
        params.retain();
        return createLease();
      },
      createScrub() {
        return createScrub(lease.retain());
      },
    };
    return lease;
  };
  function createScrub(lease: AcquiredPluginSharedSourceSnapshot): PluginSourceSnapshotScrub {
    type Frame = {
      filename: string;
      iterator: ReturnType<Root["entries"]>;
      entry?: PluginSourceSnapshotEntry;
    };
    type Pending = { filename: string; entry: FileEntry; fd: number; hash: Hash; offset: number };
    const frames: Frame[] = [];
    const seen = new Set<string>();
    let pending: Pending | undefined;
    let guardedRoot: Root | undefined;
    let disposed = false;
    let done = false;
    let totalFiles = 0;
    let totalBytes = 0;
    let totalElapsedMs = 0;
    let closing: Promise<void> | undefined;
    const dispose = () =>
      (closing ??= (async () => {
        disposed = true;
        try {
          if (pending) {
            fs.closeSync(pending.fd);
            pending = undefined;
          }
          const outcomes = await Promise.allSettled(
            frames.splice(0).map(async (frame) => await frame.iterator.return?.()),
          );
          const failed = outcomes.find((outcome) => outcome.status === "rejected");
          if (failed?.status === "rejected") {
            throw failed.reason;
          }
        } finally {
          lease.release();
        }
      })());
    return {
      dispose,
      async step({ maxFiles, maxBytes, signal }) {
        if (
          !Number.isSafeInteger(maxFiles) ||
          maxFiles < 1 ||
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1
        ) {
          throw new RangeError("Snapshot scrub budgets must be positive safe integers");
        }
        if (disposed && !done) {
          throw new Error("Snapshot scrub has been disposed");
        }
        let count = 0;
        let files = 0;
        let bytes = 0;
        const start = performance.now();
        const report = () => ({
          done,
          entries: count,
          files,
          bytes,
          totalEntries: seen.size,
          totalFiles,
          totalBytes,
          elapsedMs: performance.now() - start,
          totalElapsedMs,
        });
        if (done) {
          return report();
        }
        try {
          signal?.throwIfAborted();
          lease.assertCurrent();
          if (!guardedRoot) {
            guardedRoot = await root(payloadRoot, { symlinks: "reject", hardlinks: "reject" });
            lease.assertCurrent();
            frames.push({
              filename: payloadRoot,
              iterator: guardedRoot.entries(".", { order: "filesystem" }),
            });
          }
          while (count < maxFiles && bytes < maxBytes) {
            signal?.throwIfAborted();
            if (disposed) {
              throw new Error("Snapshot scrub has been disposed");
            }
            if (pending) {
              const buffer = Buffer.allocUnsafe(
                Math.min(
                  64 * 1024,
                  maxBytes - bytes,
                  Math.max(1, pending.entry.sizeBytes - pending.offset + 1),
                ),
              );
              const length = fs.readSync(pending.fd, buffer, 0, buffer.length, pending.offset);
              if (length > 0) {
                pending.hash.update(buffer.subarray(0, length));
                pending.offset += length;
                bytes += length;
                totalBytes += length;
                if (pending.offset > pending.entry.sizeBytes) {
                  fail(`snapshot file grew during scrub: ${pending.filename}`);
                }
                continue;
              }
              if (
                pending.offset !== pending.entry.sizeBytes ||
                pending.hash.digest("hex") !== pending.entry.contentHash
              ) {
                fail(`snapshot file bytes changed during scrub: ${pending.filename}`);
              }
              assertStat(
                pending.filename,
                pending.entry,
                fs.fstatSync(pending.fd, { bigint: true }),
              );
              resolveMember(pending.filename);
              fs.closeSync(pending.fd);
              pending = undefined;
              files++;
              totalFiles++;
              continue;
            }
            const frame = frames.at(-1);
            if (!frame) {
              if (seen.size !== entries.size) {
                fail(`snapshot membership changed during scrub: ${payloadRoot}`);
              }
              lease.assertCurrent();
              done = true;
              break;
            }
            const next = await frame.iterator.next();
            signal?.throwIfAborted();
            if (disposed) {
              throw new Error("Snapshot scrub has been disposed");
            }
            if (next.done) {
              count++;
              if (frame.entry) {
                assertStat(
                  frame.filename,
                  frame.entry,
                  fs.lstatSync(frame.filename, { bigint: true }),
                );
              } else {
                lease.assertCurrent();
              }
              await frame.iterator.return?.();
              frames.pop();
              continue;
            }
            const filename = path.join(frame.filename, next.value.name);
            const entry = entries.get(filename);
            if (!entry || seen.has(filename)) {
              fail(`snapshot membership changed during scrub: ${filename}`);
            }
            assertStat(filename, entry, fs.lstatSync(filename, { bigint: true }));
            seen.add(filename);
            count++;
            if (entry.kind === "directory") {
              frames.push({
                filename,
                entry,
                iterator: guardedRoot.entries(path.relative(payloadRoot, filename), {
                  order: "filesystem",
                }),
              });
            } else if (entry.kind === "link") {
              resolveMember(filename);
            } else {
              pending = { ...openVerified(filename), hash: createHash("sha256"), offset: 0 };
            }
          }
          if (done) {
            await dispose();
          }
          totalElapsedMs += performance.now() - start;
          return report();
        } catch (error) {
          await dispose();
          if (signal?.aborted) {
            throw error;
          }
          return checked(payloadRoot, () => {
            throw error;
          });
        }
      },
    };
  }
  return createLease();
}
