import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import {
  ensureDurableDirectory,
  pinDirectory,
  publishFileNoClobber,
  requireDirectorySync,
} from "../infra/directory-durability.js";
import { isMissingPathError } from "../infra/errno.js";
import { validateStorageKey } from "./keys.js";
import type { StorageBackend, StorageProvider } from "./types.js";

function validateSettings(settings: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof settings.path !== "string" || !path.isAbsolute(settings.path)) {
    return "Filesystem storage settings.path must be an absolute directory path.";
  }
  if (Object.keys(settings).some((key) => key !== "path")) {
    return "Filesystem storage only accepts the path setting.";
  }
  return undefined;
}

function ignoreMissingPath(error: unknown): undefined {
  if (!isMissingPathError(error)) {
    throw error;
  }
}

export const filesystemStorageProvider: StorageProvider = {
  id: "filesystem",
  label: "Filesystem",
  validateSettings,
  describeTarget: (settings) => (typeof settings.path === "string" ? settings.path : undefined),
  async open({ settings, signal }) {
    const settingsError = validateSettings(settings);
    if (settingsError || typeof settings.path !== "string") {
      throw new Error(settingsError ?? "Filesystem storage requires a path.");
    }
    signal?.throwIfAborted();
    // A retained pin distinguishes an unplugged disk from its now-empty mountpoint.
    const directory = await pinDirectory(settings.path, { label: "Storage root directory" });
    try {
      const files = await root(directory.receipt.realPath, {
        symlinks: "reject",
        mutationSymlinks: "reject",
        hardlinks: "reject",
        mkdir: false,
      });
      await directory.assertCurrent();
      const readers = new Set<FileHandle>();

      async function assertCurrent(operationSignal?: AbortSignal): Promise<void> {
        operationSignal?.throwIfAborted();
        await directory.assertCurrent();
      }

      const backend: StorageBackend = {
        displayTarget: settings.path,
        async probe(opts) {
          await assertCurrent(opts?.signal);
          const stats = await fs.statfs(directory.receipt.realPath);
          await assertCurrent(opts?.signal);
          return {
            freeBytes: stats.bavail * stats.bsize,
            totalBytes: stats.blocks * stats.bsize,
          };
        },
        async putObject(key, body, opts) {
          await assertCurrent(opts.signal);
          const parentKey = path.posix.dirname(key);
          const parentPath = path.join(files.rootReal, parentKey);
          if (parentKey !== ".") {
            const created = await ensureDurableDirectory({
              directoryPath: parentPath,
              label: "Storage object directory",
              create: async () => {
                await assertCurrent(opts.signal);
                await files.mkdir(parentKey);
              },
            });
            requireDirectorySync(created.parentSync, "Storage object directory");
          }
          await assertCurrent(opts.signal);
          const parent = await pinDirectory(parentPath, { label: "Storage object directory" });
          // '~' cannot occur in a storage key, so staging files never enter object listings.
          const temporaryKey = path.posix.join(parentKey, `.openclaw-put-${randomUUID()}.tmp~`);
          let temporaryCreated = false;
          let sizeBytes = 0;
          async function* measuredBody() {
            for await (const chunk of body) {
              opts.signal?.throwIfAborted();
              sizeBytes += chunk.byteLength;
              if (opts.sizeBytes !== undefined && sizeBytes > opts.sizeBytes) {
                throw new Error(`Storage object ${key} exceeds its declared size.`);
              }
              yield chunk;
            }
            if (opts.sizeBytes !== undefined && sizeBytes !== opts.sizeBytes) {
              throw new Error(`Storage object ${key} does not match its declared size.`);
            }
          }
          try {
            await files.create(temporaryKey, measuredBody(), {
              durable: "file",
              mkdir: false,
              mode: 0o600,
              maxBytes: opts.sizeBytes ?? Number.MAX_SAFE_INTEGER,
              signal: opts.signal,
            });
            temporaryCreated = true;
            await parent.assertCurrent();
            await assertCurrent(opts.signal);
            await publishFileNoClobber(
              path.join(files.rootReal, temporaryKey),
              path.join(files.rootReal, key),
              { strategy: "link-required", moveSource: true, durability: "fail-closed" },
            );
            temporaryCreated = false;
            requireDirectorySync(await parent.sync(), "Storage object directory");
            await assertCurrent(opts.signal);
            return { sizeBytes };
          } finally {
            try {
              if (temporaryCreated) {
                // Never follow a replaced root or parent just to clean up a failed write.
                await directory.assertCurrent();
                await parent.assertCurrent();
                await files.remove(temporaryKey, { force: true });
                requireDirectorySync(await parent.sync(), "Storage object directory");
              }
            } finally {
              await parent.close();
            }
          }
        },
        async getObject(key, opts) {
          await assertCurrent(opts?.signal);
          const opened = await files.open(key).catch(ignoreMissingPath);
          if (!opened) {
            return undefined;
          }
          const handle = opened.handle;
          readers.add(handle);
          return (async function* () {
            try {
              await assertCurrent(opts?.signal);
              while (true) {
                opts?.signal?.throwIfAborted();
                const buffer = Buffer.allocUnsafe(64 * 1024);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (bytesRead === 0) {
                  break;
                }
                yield buffer.subarray(0, bytesRead);
              }
            } finally {
              readers.delete(handle);
              await handle.close();
            }
          })();
        },
        async statObject(key, opts) {
          await assertCurrent(opts?.signal);
          const stat = await files.stat(key).catch(ignoreMissingPath);
          await assertCurrent(opts?.signal);
          return stat?.isFile ? { key, sizeBytes: stat.size, modifiedAt: stat.mtimeMs } : undefined;
        },
        async *listObjects(prefix, opts) {
          await assertCurrent(opts?.signal);
          const parentKey = prefix.slice(0, prefix.lastIndexOf("/") + 1).replace(/\/$/u, "");
          const parentStat = await files.stat(parentKey || ".").catch(ignoreMissingPath);
          if (!parentStat?.isDirectory) {
            return;
          }
          for await (const entry of files.walk(parentKey, {
            symlinkPolicy: "skip",
            signal: opts?.signal,
            order: "filesystem",
            entryFilter(candidate) {
              try {
                validateStorageKey(candidate.relativePath);
              } catch {
                return "skip-subtree";
              }
              return "include";
            },
          })) {
            if (entry.kind !== "file" || !entry.relativePath.startsWith(prefix)) {
              continue;
            }
            const stat = await backend.statObject(entry.relativePath, opts);
            if (stat) {
              yield stat;
            }
          }
        },
        async deleteObject(key, opts) {
          await assertCurrent(opts?.signal);
          const stat = await backend.statObject(key, opts);
          if (!stat) {
            return;
          }
          const parent = await pinDirectory(path.dirname(path.join(files.rootReal, key)));
          try {
            await assertCurrent(opts?.signal);
            await files.remove(key, { force: true, signal: opts?.signal });
            requireDirectorySync(await parent.sync(), "Storage object directory");
          } finally {
            await parent.close();
          }
        },
        async close() {
          try {
            await Promise.all([...readers].map((handle) => handle.close()));
          } finally {
            readers.clear();
            await directory.close();
          }
        },
      };
      return backend;
    } catch (error) {
      await directory.close();
      throw error;
    }
  },
};
