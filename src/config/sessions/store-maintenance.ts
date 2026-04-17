import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeStringifiedOptionalString } from "../../shared/string-coerce.js";
import { loadConfig } from "../config.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import { formatSessionArchiveTimestamp, isPrimarySessionTranscriptFileName } from "./artifacts.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store");

const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_ENTRIES = 500;
const DEFAULT_SESSION_ROTATE_BYTES = 10_485_760; // 10 MB
const DEFAULT_SESSION_MAINTENANCE_MODE: SessionMaintenanceMode = "warn";
const DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO = 0.8;
const MAX_ROTATION_BACKUPS = 3;

export type SessionMaintenanceWarning = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};

export type ResolvedSessionMaintenanceConfig = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  rotateBytes: number;
  resetArchiveRetentionMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
  transcriptRotateBytes: number | null;
  transcriptMaxLines: number | null;
};

function resolvePruneAfterMs(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.pruneAfter ?? maintenance?.pruneDays;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" });
  } catch {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
}

function resolveRotateBytes(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.rotateBytes;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return DEFAULT_SESSION_ROTATE_BYTES;
  }
  try {
    return parseByteSize(normalized, { defaultUnit: "b" });
  } catch {
    return DEFAULT_SESSION_ROTATE_BYTES;
  }
}

function resolveResetArchiveRetentionMs(
  maintenance: SessionMaintenanceConfig | undefined,
  pruneAfterMs: number,
): number | null {
  const raw = maintenance?.resetArchiveRetention;
  if (raw === false) {
    return null;
  }
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return pruneAfterMs;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" });
  } catch {
    return pruneAfterMs;
  }
}

function resolveMaxDiskBytes(maintenance?: SessionMaintenanceConfig): number | null {
  const raw = maintenance?.maxDiskBytes;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return null;
  }
  try {
    return parseByteSize(normalized, { defaultUnit: "b" });
  } catch {
    return null;
  }
}

function resolveHighWaterBytes(
  maintenance: SessionMaintenanceConfig | undefined,
  maxDiskBytes: number | null,
): number | null {
  const computeDefault = () => {
    if (maxDiskBytes == null) {
      return null;
    }
    if (maxDiskBytes <= 0) {
      return 0;
    }
    return Math.max(
      1,
      Math.min(
        maxDiskBytes,
        Math.floor(maxDiskBytes * DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO),
      ),
    );
  };
  if (maxDiskBytes == null) {
    return null;
  }
  const raw = maintenance?.highWaterBytes;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return computeDefault();
  }
  try {
    const parsed = parseByteSize(normalized, { defaultUnit: "b" });
    return Math.min(parsed, maxDiskBytes);
  } catch {
    return computeDefault();
  }
}

function resolveTranscriptRotateBytes(maintenance?: SessionMaintenanceConfig): number | null {
  const raw = maintenance?.transcriptRotateBytes;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return null;
  }
  try {
    const parsed = parseByteSize(normalized, { defaultUnit: "b" });
    return parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function resolveTranscriptMaxLines(maintenance?: SessionMaintenanceConfig): number | null {
  const raw = maintenance?.transcriptMaxLines;
  if (raw == null) {
    return null;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve maintenance settings from openclaw.json (`session.maintenance`).
 * Falls back to built-in defaults when config is missing or unset.
 */
export function resolveMaintenanceConfigFromInput(
  maintenance?: SessionMaintenanceConfig,
): ResolvedSessionMaintenanceConfig {
  const pruneAfterMs = resolvePruneAfterMs(maintenance);
  const maxDiskBytes = resolveMaxDiskBytes(maintenance);
  return {
    mode: maintenance?.mode ?? DEFAULT_SESSION_MAINTENANCE_MODE,
    pruneAfterMs,
    maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
    rotateBytes: resolveRotateBytes(maintenance),
    resetArchiveRetentionMs: resolveResetArchiveRetentionMs(maintenance, pruneAfterMs),
    maxDiskBytes,
    highWaterBytes: resolveHighWaterBytes(maintenance, maxDiskBytes),
    transcriptRotateBytes: resolveTranscriptRotateBytes(maintenance),
    transcriptMaxLines: resolveTranscriptMaxLines(maintenance),
  };
}

export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  let maintenance: SessionMaintenanceConfig | undefined;
  try {
    maintenance = loadConfig().session?.maintenance;
  } catch {
    // Config may not be available (e.g. in tests). Use defaults.
  }
  return resolveMaintenanceConfigFromInput(maintenance);
}

/**
 * Remove entries whose `updatedAt` is older than the configured threshold.
 * Entries without `updatedAt` are kept (cannot determine staleness).
 * Mutates `store` in-place.
 */
export function pruneStaleEntries(
  store: Record<string, SessionEntry>,
  overrideMaxAgeMs?: number,
  opts: { log?: boolean; onPruned?: (params: { key: string; entry: SessionEntry }) => void } = {},
): number {
  const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfig().pruneAfterMs;
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
      opts.onPruned?.({ key, entry });
      delete store[key];
      pruned++;
    }
  }
  if (pruned > 0 && opts.log !== false) {
    log.info("pruned stale session entries", { pruned, maxAgeMs });
  }
  return pruned;
}

function getEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

export function getActiveSessionMaintenanceWarning(params: {
  store: Record<string, SessionEntry>;
  activeSessionKey: string;
  pruneAfterMs: number;
  maxEntries: number;
  nowMs?: number;
}): SessionMaintenanceWarning | null {
  const activeSessionKey = params.activeSessionKey.trim();
  if (!activeSessionKey) {
    return null;
  }
  const activeEntry = params.store[activeSessionKey];
  if (!activeEntry) {
    return null;
  }
  const now = params.nowMs ?? Date.now();
  const cutoffMs = now - params.pruneAfterMs;
  const wouldPrune = activeEntry.updatedAt != null ? activeEntry.updatedAt < cutoffMs : false;
  const keys = Object.keys(params.store);
  const wouldCap =
    keys.length > params.maxEntries &&
    keys
      .toSorted((a, b) => getEntryUpdatedAt(params.store[b]) - getEntryUpdatedAt(params.store[a]))
      .slice(params.maxEntries)
      .includes(activeSessionKey);

  if (!wouldPrune && !wouldCap) {
    return null;
  }

  return {
    activeSessionKey,
    activeUpdatedAt: activeEntry.updatedAt,
    totalEntries: keys.length,
    pruneAfterMs: params.pruneAfterMs,
    maxEntries: params.maxEntries,
    wouldPrune,
    wouldCap,
  };
}

/**
 * Cap the store to the N most recently updated entries.
 * Entries without `updatedAt` are sorted last (removed first when over limit).
 * Mutates `store` in-place.
 */
export function capEntryCount(
  store: Record<string, SessionEntry>,
  overrideMax?: number,
  opts: {
    log?: boolean;
    onCapped?: (params: { key: string; entry: SessionEntry }) => void;
  } = {},
): number {
  const maxEntries = overrideMax ?? resolveMaintenanceConfig().maxEntries;
  const keys = Object.keys(store);
  if (keys.length <= maxEntries) {
    return 0;
  }

  // Sort by updatedAt descending; entries without updatedAt go to the end (removed first).
  const sorted = keys.toSorted((a, b) => {
    const aTime = getEntryUpdatedAt(store[a]);
    const bTime = getEntryUpdatedAt(store[b]);
    return bTime - aTime;
  });

  const toRemove = sorted.slice(maxEntries);
  for (const key of toRemove) {
    const entry = store[key];
    if (entry) {
      opts.onCapped?.({ key, entry });
    }
    delete store[key];
  }
  if (opts.log !== false) {
    log.info("capped session entry count", { removed: toRemove.length, maxEntries });
  }
  return toRemove.length;
}

async function getSessionFileSize(storePath: string): Promise<number | null> {
  try {
    const stat = await fs.promises.stat(storePath);
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Rotate the sessions file if it exceeds the configured size threshold.
 * Renames the current file to `sessions.json.bak.{timestamp}` and cleans up
 * old rotation backups, keeping only the 3 most recent `.bak.*` files.
 */
export async function rotateSessionFile(
  storePath: string,
  overrideBytes?: number,
): Promise<boolean> {
  const maxBytes = overrideBytes ?? resolveMaintenanceConfig().rotateBytes;

  // Check current file size (file may not exist yet).
  const fileSize = await getSessionFileSize(storePath);
  if (fileSize == null) {
    return false;
  }

  if (fileSize <= maxBytes) {
    return false;
  }

  // Rotate: rename current file to .bak.{timestamp}
  const backupPath = `${storePath}.bak.${Date.now()}`;
  try {
    await fs.promises.rename(storePath, backupPath);
    log.info("rotated session store file", {
      backupPath: path.basename(backupPath),
      sizeBytes: fileSize,
    });
  } catch {
    // If rename fails (e.g. file disappeared), skip rotation.
    return false;
  }

  // Clean up old backups — keep only the 3 most recent .bak.* files.
  try {
    const dir = path.dirname(storePath);
    const baseName = path.basename(storePath);
    const files = await fs.promises.readdir(dir);
    const backups = files
      .filter((f) => f.startsWith(`${baseName}.bak.`))
      .toSorted()
      .toReversed();

    if (backups.length > MAX_ROTATION_BACKUPS) {
      const toDelete = backups.slice(MAX_ROTATION_BACKUPS);
      for (const old of toDelete) {
        await fs.promises.unlink(path.join(dir, old)).catch(() => undefined);
      }
      log.info("cleaned up old session store backups", { deleted: toDelete.length });
    }
  } catch {
    // Best-effort cleanup; don't fail the write.
  }

  return true;
}

/**
 * Rotate a single transcript `.jsonl` file if it exceeds `transcriptRotateBytes`.
 *
 * This is the hot-path function called on every session store save for the
 * currently active transcript only — avoiding an expensive full-directory walk
 * per write. For bulk rotation (CLI / cron), use `rotateTranscriptFiles` instead.
 *
 * Returns `true` if the file was rotated, `false` otherwise.
 */
export async function rotateTranscriptFile(params: {
  transcriptPath: string;
  maintenance: ResolvedSessionMaintenanceConfig;
}): Promise<boolean> {
  const { transcriptPath, maintenance } = params;
  const maxBytes = maintenance.transcriptRotateBytes;
  if (maxBytes == null || maxBytes <= 0) {
    return false;
  }

  // Check file size
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(transcriptPath);
  } catch {
    return false;
  }
  if (stat.size <= maxBytes) {
    return false;
  }

  // Rotate: archive current file, write replacement with tail lines
  const archiveTimestamp = formatSessionArchiveTimestamp();
  const backupPath = `${transcriptPath}.bak.${archiveTimestamp}`;
  try {
    await fs.promises.rename(transcriptPath, backupPath);
  } catch {
    return false;
  }

  // Write replacement file with session header + most recent lines
  const maxLines = maintenance.transcriptMaxLines;
  let replacementWritten = false;
  try {
    const { headerLine: archiveHeader, tailLines } = await readHeaderAndTailLines(
      backupPath,
      maxLines ?? 0,
    );
    const headerContent = archiveHeader ?? buildDefaultSessionHeader();
    if (!archiveHeader) {
      log.warn("transcript rotation: could not read original session header; using default", {
        file: path.basename(transcriptPath),
      });
    }
    let replacementLines: string[];
    if (maxLines != null && maxLines > 0) {
      replacementLines = [headerContent, ...tailLines];
    } else {
      // No maxLines — replacement contains only the session header
      replacementLines = [headerContent];
    }
    // Use O_EXCL to avoid silently overwriting a concurrently recreated file
    try {
      const fd = await fs.promises.open(
        transcriptPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      try {
        await fd.writeFile(replacementLines.join("\n") + "\n", "utf-8");
        replacementWritten = true;
      } finally {
        await fd.close();
      }
    } catch (exclErr) {
      if ((exclErr as NodeJS.ErrnoException).code === "EEXIST") {
        // A concurrent append already recreated the file — skip replacement write.
        replacementWritten = true;
        log.warn("transcript rotation skipped replacement: file recreated concurrently", {
          file: path.basename(transcriptPath),
        });
      } else {
        throw exclErr;
      }
    }
  } catch {
    log.warn("transcript rotation: replacement file not written", {
      file: path.basename(transcriptPath),
    });
  }

  // If the replacement was not written (and no concurrent writer recreated it),
  // attempt to restore the original file from the archive to avoid data loss.
  if (!replacementWritten) {
    try {
      // Remove any partially-written replacement file before restoring the
      // original.  Without this, a truncated/corrupt file left behind by a
      // failed writeFile (e.g. ENOSPC) would satisfy an existence check and
      // prevent the restore.
      await fs.promises.unlink(transcriptPath).catch(() => undefined);
      await fs.promises.rename(backupPath, transcriptPath);
      log.warn(
        "transcript rotation: restored original file from archive after replacement failure",
        {
          file: path.basename(transcriptPath),
        },
      );
    } catch {
      log.error("transcript rotation: failed to restore original file from archive", {
        file: path.basename(transcriptPath),
        archive: path.basename(backupPath),
      });
    }
    return false;
  }

  log.info("rotated transcript file", {
    file: path.basename(transcriptPath),
    sizeBytes: stat.size,
    maxBytes,
    archiveTimestamp,
  });

  // Clean up old backups for this transcript (keep 3 most recent)
  await cleanupOldTranscriptBackups(path.dirname(transcriptPath), path.basename(transcriptPath));

  return true;
}

/**
 * Scan the sessions directory for `.jsonl` transcript files that exceed
 * `transcriptRotateBytes` and rotate them. For each oversized file:
 *
 * 1. Archive the current file as `<name>.jsonl.bak.<timestamp>`
 * 2. Keep only the last `transcriptMaxLines` lines (if configured) in the
 *    replacement file, prefixed with the session header; otherwise write a
 *    replacement file containing only the session header.
 * 3. Clean up old `.bak.*` archives (keep 3 most recent per base name).
 *
 * This performs a full directory walk and is intended for CLI / cron use.
 * The hot-path (per-write) rotation uses `rotateTranscriptFile` instead,
 * which only checks the currently active transcript.
 *
 * Returns the number of transcript files rotated.
 */
export async function rotateTranscriptFiles(params: {
  storePath: string;
  maintenance: ResolvedSessionMaintenanceConfig;
}): Promise<number> {
  const { storePath, maintenance } = params;
  const maxBytes = maintenance.transcriptRotateBytes;
  if (maxBytes == null || maxBytes <= 0) {
    return 0;
  }

  const sessionsDir = path.dirname(path.resolve(storePath));
  let rotated = 0;

  // Walk all subdirectories under sessionsDir to find .jsonl files
  async function walkDir(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!isPrimarySessionTranscriptFileName(entry.name)) {
        continue;
      }

      const wasRotated = await rotateTranscriptFile({
        transcriptPath: fullPath,
        maintenance,
      });
      if (wasRotated) {
        rotated++;
      }
    }
  }

  await walkDir(sessionsDir);
  return rotated;
}

/**
 * Build a default session header line for cases where the original file
 * had no parseable header (should not normally happen).
 */
function buildDefaultSessionHeader(): string {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: "unknown",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  return JSON.stringify(header);
}

/**
 * Read the session header and the last N message lines from a transcript file
 * in a single streaming pass. The first line is treated as the session header;
 * the remaining lines are filtered through a circular buffer to keep only the
 * most recent `maxTailLines` entries.
 *
 * Returns `{ headerLine, tailLines }` where `headerLine` may be null if the
 * file is empty or unreadable, and `tailLines` is in original order (oldest
 * to newest). If `maxTailLines` is 0 or negative, no tail lines are collected.
 */
async function readHeaderAndTailLines(
  filePath: string,
  maxTailLines: number,
): Promise<{ headerLine: string | null; tailLines: string[] }> {
  let headerLine: string | null = null;
  let lineIndex = 0;
  let head = 0;
  let count = 0;
  const shouldCollectTail = maxTailLines > 0;
  const buf: string[] | null = shouldCollectTail
    ? Array.from<string>({ length: maxTailLines })
    : null;

  try {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (lineIndex === 0) {
          headerLine = line;
          // If no tail lines needed, we can stop after reading the header
          if (!shouldCollectTail) {
            break;
          }
        } else if (shouldCollectTail && buf) {
          buf[head] = line;
          head = (head + 1) % maxTailLines;
          if (count < maxTailLines) {
            count++;
          }
        }
        lineIndex++;
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    if (!shouldCollectTail || !buf) {
      return { headerLine, tailLines: [] };
    }
    if (count < maxTailLines) {
      return { headerLine, tailLines: buf.slice(0, count) };
    }
    // Stitch circular buffer: [head..maxTailLines) + [0..head)
    return { headerLine, tailLines: [...buf.slice(head), ...buf.slice(0, head)] };
  } catch {
    return { headerLine: null, tailLines: [] };
  }
}

/**
 * Remove old `.bak.*` archives for a given transcript file, keeping only
 * the 3 most recent.
 */
async function cleanupOldTranscriptBackups(dir: string, baseName: string): Promise<void> {
  try {
    const files = await fs.promises.readdir(dir);
    const backups = files
      .filter((f) => f.startsWith(`${baseName}.bak.`))
      .toSorted()
      .toReversed();

    if (backups.length > MAX_ROTATION_BACKUPS) {
      const toDelete = backups.slice(MAX_ROTATION_BACKUPS);
      for (const old of toDelete) {
        await fs.promises.unlink(path.join(dir, old)).catch(() => undefined);
      }
      log.info("cleaned up old transcript backups", {
        file: baseName,
        deleted: toDelete.length,
      });
    }
  } catch {
    // Best-effort cleanup.
  }
}
