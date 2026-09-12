// Pins authored config dependencies before archive traversal, without writing live config.
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hashConfigIncludeRaw } from "../config/includes.js";
import { createConfigIO } from "../config/io.factory.js";
import { containsConfigIncludeDirective } from "../config/io.read-helpers.js";
import type { ReadConfigFileSnapshotForWriteResult } from "../config/io.types.js";

type CapturedConfigFile = {
  sourcePath: string;
  canonicalPath: string;
  hash: string;
  dev: number;
  ino: number;
};

export type BackupConfigCapture = {
  files: readonly CapturedConfigFile[];
  revalidate: () => Promise<void>;
  assertRootAlias?: () => Promise<void>;
};

function captureError(sourcePath: string, detail: string, cause?: unknown): Error {
  return new Error(
    `Cannot capture required config file ${sourcePath}: ${detail}. Fix the include graph or stop concurrent edits, then retry backup.`,
    { cause },
  );
}

export async function resolveBackupConfigCapture({
  snapshot,
  writeOptions,
}: ReadConfigFileSnapshotForWriteResult): Promise<BackupConfigCapture> {
  const hasIncludes =
    containsConfigIncludeDirective(snapshot.parsed) || Boolean(snapshot.includedPaths?.length);
  // The reader attaches provenance only after resolving the whole include graph,
  // even when later schema validation fails. Keep that recovery path available.
  if (
    (hasIncludes && snapshot.includeProvenance === undefined) ||
    (snapshot.exists && snapshot.raw === null)
  ) {
    throw captureError(snapshot.path, "include graph could not be resolved");
  }
  const hashes = writeOptions.includeFileHashesForWrite ?? {};
  const targets = writeOptions.includeFileTargetsForWrite ?? {};
  const files = new Map<string, string>(
    snapshot.exists
      ? [[snapshot.path, hashConfigIncludeRaw(snapshot.raw)], ...Object.entries(hashes)]
      : [],
  );
  const capture: CapturedConfigFile[] = [];
  let assertRootAlias: (() => Promise<void>) | undefined;
  const canonicalConfigDir = files.size
    ? await fs.realpath(path.dirname(snapshot.path)).catch((error: unknown) => {
        throw captureError(snapshot.path, "config directory became unavailable", error);
      })
    : path.dirname(snapshot.path);
  for (const [sourcePath, hash] of files) {
    try {
      const canonicalPath = await fs.realpath(sourcePath);
      const linkStat = await fs.lstat(sourcePath);
      const rootAlias = sourcePath === snapshot.path && linkStat.isSymbolicLink();
      const stat = rootAlias ? await fs.stat(sourcePath) : linkStat;
      if (rootAlias) {
        // Existing root links keep the archive's ordinary link
        // handling. Pin their payload and refuse a changed alias at publication.
        assertRootAlias = async () => {
          const current = await fs.lstat(sourcePath);
          if (
            current.dev !== linkStat.dev ||
            current.ino !== linkStat.ino ||
            current.ctimeMs !== linkStat.ctimeMs ||
            (await fs.realpath(sourcePath)) !== canonicalPath
          ) {
            throw captureError(sourcePath, "config alias changed during capture");
          }
        };
      }
      // A common canonical parent (e.g. macOS /var -> /private/var) is portable.
      // Nested aliases need link projection; do not silently archive only their targets.
      const projectedPath = path.resolve(
        canonicalConfigDir,
        path.relative(path.dirname(snapshot.path), sourcePath),
      );
      if (
        !stat.isFile() ||
        (!rootAlias && canonicalPath !== sourcePath && canonicalPath !== projectedPath)
      ) {
        throw captureError(sourcePath, "include alias cannot be represented in this archive");
      }
      if (sourcePath !== snapshot.path && targets[sourcePath] !== canonicalPath) {
        throw captureError(sourcePath, "include target changed or is unavailable");
      }
      capture.push({
        sourcePath: rootAlias ? canonicalPath : sourcePath,
        canonicalPath,
        hash,
        dev: stat.dev,
        ino: stat.ino,
      });
    } catch (error) {
      throw captureError(sourcePath, "file identity could not be pinned", error);
    }
  }
  // Watch paths include both lexical and canonical names. Every one must belong
  // to a successfully resolved, hash-pinned file, not a partially visited graph.
  for (const includePath of snapshot.includedPaths ?? []) {
    if (
      !capture.some((file) => file.sourcePath === includePath || file.canonicalPath === includePath)
    ) {
      throw captureError(includePath, "include inventory is incomplete");
    }
  }
  return {
    files: capture,
    assertRootAlias,
    revalidate: async () => {
      await assertRootAlias?.();
      const current = await createConfigIO({
        configPath: snapshot.path,
        observe: false,
      }).readConfigFileSnapshotForWrite();
      // A file can be reached repeatedly during discovery. Comparing the resolved
      // source as well as the last hashes prevents accepting mixed observations.
      if (
        current.snapshot.exists !== snapshot.exists ||
        current.snapshot.raw !== snapshot.raw ||
        current.snapshot.valid !== snapshot.valid ||
        !isDeepStrictEqual(current.snapshot.sourceConfig, snapshot.sourceConfig) ||
        !isDeepStrictEqual(current.snapshot.includedPaths, snapshot.includedPaths) ||
        !isDeepStrictEqual(current.snapshot.includeProvenance, snapshot.includeProvenance) ||
        !isDeepStrictEqual(current.writeOptions.includeFileHashesForWrite ?? {}, hashes) ||
        !isDeepStrictEqual(current.writeOptions.includeFileTargetsForWrite ?? {}, targets)
      ) {
        throw captureError(snapshot.path, "include graph changed during capture");
      }
    },
  };
}

async function readCapturedConfig(file: CapturedConfigFile): Promise<Buffer> {
  try {
    const handle = await fs.open(file.sourcePath, "r");
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.dev !== file.dev ||
        stat.ino !== file.ino ||
        (await fs.realpath(file.sourcePath)) !== file.canonicalPath ||
        !(await fs.lstat(file.sourcePath)).isFile()
      ) {
        throw new Error("file identity changed");
      }
      const bytes = await handle.readFile();
      const raw = bytes.toString("utf8");
      if (!bytes.equals(Buffer.from(raw)) || hashConfigIncludeRaw(raw) !== file.hash) {
        throw new Error("file contents changed");
      }
      const current = await fs.lstat(file.sourcePath);
      if (
        !current.isFile() ||
        current.dev !== file.dev ||
        current.ino !== file.ino ||
        (await fs.realpath(file.sourcePath)) !== file.canonicalPath
      ) {
        throw new Error("file identity changed during read");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw captureError(file.sourcePath, "source changed or became unreadable", error);
  }
}

export async function stageBackupConfigCapture(
  capture: BackupConfigCapture | undefined,
  tempDir: string,
): Promise<Map<string, string>> {
  const remaps = new Map<string, string>();
  for (const [index, file] of (capture?.files ?? []).entries()) {
    const bytes = await readCapturedConfig(file);
    const stagedPath = path.join(tempDir, `config-${index}`);
    await fs.writeFile(stagedPath, bytes, { flag: "wx", mode: 0o600 });
    remaps.set(stagedPath, file.canonicalPath);
  }
  await capture?.revalidate();
  // Seal only after every dependency has been copied. Matching all authored
  // bytes also pins the include edges; no second resolver or mixed retry.
  for (const file of capture?.files ?? []) {
    await readCapturedConfig(file);
  }
  return remaps;
}
