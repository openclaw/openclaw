import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { sha256File } from "../infra/directory-durability.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import {
  compareWorkerBundlePaths,
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ARTIFACT_MODE,
  type WorkerBundleHashEntry,
} from "./worker-bundle-hash.js";

export { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "./worker-bundle-limits.js";

const MAX_ENTRY_PATH_LENGTH = 1024;
const MAX_ARCHIVE_DEPTH = 64;
const MAX_DECOMPRESSION_RATIO = 64;

type WorkerBundleArchiveLimits = {
  maxEntries: number;
  maxExpandedBytes: number;
};

function requireArchivePath(value: string): string {
  if (
    !value ||
    value.length > MAX_ENTRY_PATH_LENGTH ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    path.posix.normalize(value) !== value ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`Invalid worker bundle archive path: ${value}`);
  }
  return value;
}

export async function readWorkerBundleArchiveManifest(
  tarballPath: string,
  limits: WorkerBundleArchiveLimits,
): Promise<WorkerBundleHashEntry[]> {
  const pending: Array<{
    path: string;
    mode: number | undefined;
    headerSize: number;
    actualSize: number;
    type: string;
    sha256?: string;
    error?: Error;
  }> = [];
  const paths = new Set<string>();
  let expandedBytes = 0;
  const parser = tar.list({
    strict: true,
    maxDepth: MAX_ARCHIVE_DEPTH,
    maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
    onReadEntry(entry) {
      try {
        const entryPath = requireArchivePath(entry.path);
        if (paths.has(entryPath)) {
          throw new Error(`Duplicate worker bundle archive path: ${entryPath}`);
        }
        paths.add(entryPath);
        if (paths.size > limits.maxEntries) {
          throw new Error("Worker bundle archive exceeds its entry limit");
        }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
          throw new Error(`Invalid worker bundle archive size: ${entryPath}`);
        }
        expandedBytes += entry.size;
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) {
          throw new Error("Worker bundle archive exceeds its expanded byte limit");
        }
        const hash = createHash("sha256");
        const item = {
          path: entryPath,
          mode: entry.mode,
          headerSize: entry.size,
          actualSize: 0,
          type: entry.type,
        } as (typeof pending)[number];
        pending.push(item);
        entry.on("data", (chunk: Buffer) => {
          item.actualSize += chunk.byteLength;
          hash.update(chunk);
        });
        entry.on("end", () => {
          item.sha256 = hash.digest("hex");
        });
        entry.on("error", (error) => {
          item.error = error instanceof Error ? error : new Error(String(error));
        });
      } catch (error) {
        // Entry callbacks run outside the awaited promise. Abort through tar's error owner.
        parser.abort(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  try {
    // Match tar.list(file): compressed read grouping affects its prefix ratio check.
    await pipeline(createReadStream(tarballPath, { highWaterMark: 16 * 1024 * 1024 }), parser);
  } catch (error) {
    // Parser has no destroy method; release its decompressor on parser and input failures too.
    parser.abort(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  return pending
    .map((entry): WorkerBundleHashEntry => {
      if (entry.error) {
        throw entry.error;
      }
      if (
        entry.type !== "File" ||
        entry.mode === undefined ||
        entry.actualSize !== entry.headerSize ||
        entry.sha256 === undefined
      ) {
        throw new Error(`Invalid worker bundle tar entry: ${entry.path}`);
      }
      return {
        path: entry.path,
        mode: process.platform === "win32" ? WORKER_BUNDLE_ARTIFACT_MODE : entry.mode,
        size: entry.actualSize,
        sha256: entry.sha256,
      };
    })
    .toSorted((left, right) => compareWorkerBundlePaths(left.path, right.path));
}

export async function readWorkerBundleDirectoryManifest(params: {
  root: string;
  limits: WorkerBundleArchiveLimits;
  ignoreTopLevel?: ReadonlySet<string>;
}): Promise<WorkerBundleHashEntry[]> {
  const root = await fsSafeRoot(params.root);
  const entries: WorkerBundleHashEntry[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (!relativeRoot && params.ignoreTopLevel?.has(child.name)) {
        continue;
      }
      const relative = requireArchivePath(
        relativeRoot ? `${relativeRoot}/${child.name}` : child.name,
      );
      const absolute = path.join(directory, child.name);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(`Worker bundle contains a symbolic link: ${relative}`);
      }
      if (stats.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Worker bundle contains an unsupported entry: ${relative}`);
      }
      // Keep literal inventory names such as "~/worker.mjs" from expanding to the home directory.
      const opened = await root.open(absolute, { symlinks: "reject", hardlinks: "allow" });
      try {
        totalBytes += opened.stat.size;
        if (
          entries.length >= params.limits.maxEntries ||
          !Number.isSafeInteger(totalBytes) ||
          totalBytes > params.limits.maxExpandedBytes
        ) {
          throw new Error("Worker bundle directory exceeds its limits");
        }
        const hash = await sha256File(opened.handle, { maxBytes: opened.stat.size });
        if (hash.bytes !== opened.stat.size) {
          throw new Error(`Worker bundle file changed while hashing: ${relative}`);
        }
        entries.push({
          path: relative,
          mode:
            process.platform === "win32" ? WORKER_BUNDLE_ARTIFACT_MODE : opened.stat.mode & 0o777,
          size: opened.stat.size,
          sha256: hash.digest,
        });
      } finally {
        await opened.handle.close();
      }
    }
  };
  await visit(root.rootReal, "");
  return entries.toSorted((left, right) => compareWorkerBundlePaths(left.path, right.path));
}

export async function extractWorkerBundleArchive(params: {
  tarballPath: string;
  destination: string;
  expectedBundleHash: string;
  limits: WorkerBundleArchiveLimits;
}): Promise<void> {
  const manifest = await readWorkerBundleArchiveManifest(params.tarballPath, params.limits);
  if (hashWorkerBundleManifest(manifest) !== params.expectedBundleHash) {
    throw new Error("Worker bundle archive manifest does not match its expected hash");
  }
  const allowed = new Set(manifest.map((entry) => entry.path));
  await fs.mkdir(params.destination, { recursive: true, mode: 0o700 });
  await tar.extract({
    cwd: params.destination,
    file: params.tarballPath,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    chmod: true,
    processUmask: 0o077,
    maxDepth: MAX_ARCHIVE_DEPTH,
    maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
    filter: (entryPath) => allowed.has(entryPath),
  });
  const extracted = await readWorkerBundleDirectoryManifest({
    root: params.destination,
    limits: params.limits,
  });
  if (hashWorkerBundleManifest(extracted) !== params.expectedBundleHash) {
    throw new Error("Extracted worker bundle does not match its expected hash");
  }
}
