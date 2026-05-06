import fs from "node:fs";
import path from "node:path";
import { replaceFileAtomic } from "./replace-file.js";

export type JsonDurableQueueEntryPath = {
  jsonPath: string;
  deliveredPath: string;
};

export type JsonDurableQueueReadResult<T> = {
  entry: T;
  migrated?: boolean;
};

type LoadPendingJsonQueueEntriesOptions<T> = {
  queueDir: string;
  tempPrefix: string;
  read?: (entry: T, filePath: string) => Promise<JsonDurableQueueReadResult<T>>;
  cleanupTmpMaxAgeMs?: number;
};

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

export async function unlinkBestEffort(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath).catch(() => undefined);
}

export async function jsonDurableQueueEntryExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function unlinkStaleTmpBestEffort(
  filePath: string,
  now: number,
  maxAgeMs: number,
): Promise<void> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile() && now - stat.mtimeMs >= maxAgeMs) {
      await unlinkBestEffort(filePath);
    }
  } catch (err) {
    if (getErrnoCode(err) !== "ENOENT") {
      throw err;
    }
  }
}

export function resolveJsonDurableQueueEntryPaths(
  queueDir: string,
  id: string,
): JsonDurableQueueEntryPath {
  return {
    jsonPath: path.join(queueDir, `${id}.json`),
    deliveredPath: path.join(queueDir, `${id}.delivered`),
  };
}

export async function ensureJsonDurableQueueDirs(params: {
  queueDir: string;
  failedDir: string;
}): Promise<void> {
  await fs.promises.mkdir(params.queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(params.failedDir, { recursive: true, mode: 0o700 });
}

export async function writeJsonDurableQueueEntry(params: {
  filePath: string;
  entry: unknown;
  tempPrefix: string;
}): Promise<void> {
  await replaceFileAtomic({
    filePath: params.filePath,
    content: JSON.stringify(params.entry, null, 2),
    mode: 0o600,
    tempPrefix: params.tempPrefix,
  });
}

export async function readJsonDurableQueueEntry<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as T;
}

export async function ackJsonDurableQueueEntry(paths: JsonDurableQueueEntryPath): Promise<void> {
  try {
    await fs.promises.rename(paths.jsonPath, paths.deliveredPath);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      await unlinkBestEffort(paths.deliveredPath);
      return;
    }
    throw err;
  }
  await unlinkBestEffort(paths.deliveredPath);
}

export async function loadJsonDurableQueueEntry<T>(params: {
  paths: JsonDurableQueueEntryPath;
  tempPrefix: string;
  read?: (entry: T, filePath: string) => Promise<JsonDurableQueueReadResult<T>>;
}): Promise<T | null> {
  try {
    const stat = await fs.promises.stat(params.paths.jsonPath);
    if (!stat.isFile()) {
      return null;
    }
    const raw = await readJsonDurableQueueEntry<T>(params.paths.jsonPath);
    const result = params.read ? await params.read(raw, params.paths.jsonPath) : { entry: raw };
    if (result.migrated) {
      await writeJsonDurableQueueEntry({
        filePath: params.paths.jsonPath,
        entry: result.entry,
        tempPrefix: params.tempPrefix,
      });
    }
    return result.entry;
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function loadPendingJsonDurableQueueEntries<T>(
  options: LoadPendingJsonQueueEntriesOptions<T>,
): Promise<T[]> {
  let files: string[];
  try {
    files = await fs.promises.readdir(options.queueDir);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return [];
    }
    throw err;
  }

  const now = Date.now();
  for (const file of files) {
    if (file.endsWith(".delivered")) {
      await unlinkBestEffort(path.join(options.queueDir, file));
    } else if (options.cleanupTmpMaxAgeMs !== undefined && file.endsWith(".tmp")) {
      await unlinkStaleTmpBestEffort(
        path.join(options.queueDir, file),
        now,
        options.cleanupTmpMaxAgeMs,
      );
    }
  }

  const entries: T[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(options.queueDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await readJsonDurableQueueEntry<T>(filePath);
      const result = options.read ? await options.read(raw, filePath) : { entry: raw };
      if (result.migrated) {
        await writeJsonDurableQueueEntry({
          filePath,
          entry: result.entry,
          tempPrefix: options.tempPrefix,
        });
      }
      entries.push(result.entry);
    } catch {
      continue;
    }
  }
  return entries;
}

export async function moveJsonDurableQueueEntryToFailed(params: {
  queueDir: string;
  failedDir: string;
  id: string;
}): Promise<void> {
  await fs.promises.mkdir(params.failedDir, { recursive: true, mode: 0o700 });
  await fs.promises.rename(
    path.join(params.queueDir, `${params.id}.json`),
    path.join(params.failedDir, `${params.id}.json`),
  );
}
