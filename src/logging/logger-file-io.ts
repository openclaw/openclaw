import fs from "node:fs";
import path from "node:path";
import { appendRegularFile } from "@openclaw/fs-safe/advanced";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { LOG_PREFIX, LOG_SUFFIX } from "./log-file-shared.js";

const MAX_ROTATED_LOG_FILES = 5;
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000;

function rotatedLogPath(file: string, index: number): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.${index}${ext}`;
}

/**
 * Creates a log directory and its missing parents with a bounded number of mkdir calls.
 * Node's recursive mkdirSync retries forever when a parent exists but refuses new
 * children (a deleted directory that is still mounted, such as a stale systemd
 * PrivateTmp), which would block the event loop inside the logger.
 */
function ensureLogDirectorySync(dir: string, createParents = true): void {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "EEXIST" && fs.statSync(dir).isDirectory()) {
      return;
    }
    const parent = path.dirname(dir);
    if (!createParents || code !== "ENOENT" || parent === dir) {
      throw error;
    }
    ensureLogDirectorySync(parent);
    // One retry once the parents exist; a second ENOENT is final.
    ensureLogDirectorySync(dir, false);
  }
}

export function rotateLogFile(file: string): boolean {
  try {
    ensureLogDirectorySync(path.dirname(file));
    fs.rmSync(rotatedLogPath(file, MAX_ROTATED_LOG_FILES), { force: true });
    for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
      const from = rotatedLogPath(file, index);
      if (fs.existsSync(from)) {
        fs.renameSync(from, rotatedLogPath(file, index + 1));
      }
    }
    if (fs.existsSync(file)) {
      fs.renameSync(file, rotatedLogPath(file, 1));
    }
    return true;
  } catch {
    return false;
  }
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // ignore errors during pruning
      }
    }
  } catch {
    // ignore missing dir or read errors
  }
}

export function prepareFileLogTarget(file: string, rolling: boolean): void {
  ensureLogDirectorySync(path.dirname(file));
  if (rolling) {
    pruneOldRollingLogs(path.dirname(file));
  }
}

export type FileLogIORequest =
  | { type: "prepare"; file: string; rolling: boolean }
  | { type: "size"; file: string }
  | { type: "append"; file: string; payload: string; rotate: boolean };
export type FileLogIOResults = {
  prepare: void;
  size: number;
  append: { rotation: "none" | "rotated" | "failed"; appended: boolean };
};

/** Filesystem-only unit; ordinary transport requests run in the logging worker. */
export async function executeFileLogIO(
  request: FileLogIORequest,
): Promise<FileLogIOResults[keyof FileLogIOResults]> {
  switch (request.type) {
    case "prepare":
      return prepareFileLogTarget(request.file, request.rolling);
    case "size":
      try {
        return fs.statSync(request.file).size;
      } catch {
        return 0;
      }
    case "append": {
      const rotation = request.rotate
        ? rotateLogFile(request.file)
          ? "rotated"
          : "failed"
        : "none";
      try {
        await appendRegularFile({ filePath: request.file, content: request.payload });
        return { rotation, appended: true };
      } catch {
        return { rotation, appended: false };
      }
    }
  }
}
