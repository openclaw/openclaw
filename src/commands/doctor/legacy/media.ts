import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime } from "../../../media/mime.js";
import { MEDIA_MAX_BYTES, saveMediaBufferWithId } from "../../../media/store.js";
import { readLocalFileSafely } from "../../../media/store.runtime.js";
import { resolveConfigDir } from "../../../utils.js";

export type LegacyMediaImportResult = {
  files: number;
  imported: number;
  removed: number;
  skipped: number;
};

function resolveLegacyMediaDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveConfigDir(env), "media");
}

function resolveLegacyMediaSubdir(subdir: string): string {
  if (typeof subdir !== "string") {
    throw new Error(`unsafe legacy media subdir: ${JSON.stringify(subdir)}`);
  }
  if (!subdir || subdir === ".") {
    return "";
  }
  if (
    subdir.includes("\0") ||
    path.isAbsolute(subdir) ||
    path.posix.isAbsolute(subdir) ||
    path.win32.isAbsolute(subdir)
  ) {
    throw new Error(`unsafe legacy media subdir: ${JSON.stringify(subdir)}`);
  }
  const segments = subdir.split(/[\\/]+/u);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`unsafe legacy media subdir: ${JSON.stringify(subdir)}`);
  }
  return path.join(...segments);
}

function assertSafeLegacyMediaId(id: string): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "..") {
    throw new Error(`unsafe legacy media ID: ${JSON.stringify(id)}`);
  }
}

async function legacyMediaFileCandidates(
  root: string,
): Promise<Array<{ path: string; subdir: string; id: string }>> {
  const candidates: Array<{ path: string; subdir: string; id: string }> = [];
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativeDir = path.relative(root, dir);
      const posixRelativeDir = relativeDir.split(path.sep).join("/");
      if (
        posixRelativeDir === "outgoing/records" ||
        posixRelativeDir.startsWith("outgoing/records/")
      ) {
        continue;
      }
      const subdir = relativeDir === "" ? "" : relativeDir;
      candidates.push({ path: entryPath, subdir, id: entry.name });
    }
  }
  await visit(root);
  return candidates;
}

async function pruneEmptyLegacyMediaDirs(dir: string, root: string): Promise<void> {
  if (dir === root || !dir.startsWith(root + path.sep)) {
    return;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  if (entries.length > 0) {
    return;
  }
  await fs.rmdir(dir).catch(() => {});
  await pruneEmptyLegacyMediaDirs(path.dirname(dir), root);
}

export async function legacyMediaFilesExist(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const root = resolveLegacyMediaDir(env);
  const candidates = await legacyMediaFileCandidates(root);
  return candidates.length > 0;
}

export async function importLegacyMediaFilesToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyMediaImportResult> {
  const root = resolveLegacyMediaDir(env);
  const candidates = await legacyMediaFileCandidates(root);
  const result: LegacyMediaImportResult = {
    files: candidates.length,
    imported: 0,
    removed: 0,
    skipped: 0,
  };

  for (const candidate of candidates) {
    try {
      const safeSubdir = resolveLegacyMediaSubdir(candidate.subdir);
      assertSafeLegacyMediaId(candidate.id);
      const { buffer } = await readLocalFileSafely({
        filePath: candidate.path,
        maxBytes: MEDIA_MAX_BYTES,
      });
      const contentType = await detectMime({ buffer, filePath: candidate.path });
      await saveMediaBufferWithId({
        subdir: safeSubdir,
        id: candidate.id,
        buffer,
        contentType,
      });
      result.imported += 1;
      await fs.rm(candidate.path, { force: true });
      result.removed += 1;
      await pruneEmptyLegacyMediaDirs(path.dirname(candidate.path), root);
    } catch {
      result.skipped += 1;
    }
  }

  return result;
}
