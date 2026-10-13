// Cleanup, disk-budget, and usage accounting use these predicates to avoid deleting live transcripts.

import { timestampMsToIsoFileStamp } from "@openclaw/normalization-core/number-coercion";
import { escapeRegExp } from "../../shared/regexp.js";
import { stripSessionArchiveCompressionSuffix } from "./archive-compression.js";

export type SessionArchiveReason = "bak" | "reset" | "deleted";

const ARCHIVE_SUFFIX_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z)(?:\.([0-9a-f]{32}))?$/;
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;
const PRE_DOCTOR_REPAIR_RE =
  /\.jsonl\.pre-doctor-(?:branch|openai-codex)-repair-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/u;
const MIGRATION_ARCHIVE_RE = /\.migrated(?:\.\d+)?$/u;
const COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

function readSessionArchiveTimestamp(
  fileName: string,
  reason: SessionArchiveReason,
): string | undefined {
  // Compressed archives carry a trailing .zst; strip it so every classifier
  // sees one canonical `<id>.jsonl.<reason>.<timestamp>[.<generation>]` shape.
  const marker = `.${reason}.`;
  const normalized = stripSessionArchiveCompressionSuffix(fileName);
  const index = normalized.lastIndexOf(marker);
  if (index < 0) {
    return undefined;
  }
  return ARCHIVE_SUFFIX_RE.exec(normalized.slice(index + marker.length))?.[1];
}

function hasArchiveSuffix(fileName: string, reason: SessionArchiveReason): boolean {
  return readSessionArchiveTimestamp(fileName, reason) !== undefined;
}

/** Returns true for archived session artifacts and legacy store backup names. */
export function isSessionArchiveArtifactName(fileName: string): boolean {
  return LEGACY_STORE_BACKUP_RE.test(fileName) || isRetainedSessionTranscriptArchiveName(fileName);
}

/** Returns true for retained archives and disposable legacy compact backups pruned at high water. */
export function isRetainedSessionTranscriptArchiveName(fileName: string): boolean {
  return (
    hasArchiveSuffix(fileName, "deleted") ||
    hasArchiveSuffix(fileName, "reset") ||
    hasArchiveSuffix(fileName, "bak")
  );
}

/** Returns true for migration rollback archives retained beside their legacy source. */
export function isMigrationArchiveArtifactName(fileName: string): boolean {
  return MIGRATION_ARCHIVE_RE.test(fileName) || PRE_DOCTOR_REPAIR_RE.test(fileName);
}

// Compiled-pattern cache keyed by store basename. A disk sweep calls the matcher
// once per file, so compiling the per-store pattern once (basenames are few — one
// per agent store) keeps the hot path allocation-free.
const SESSION_STORE_TEMP_RE_CACHE = new Map<string, RegExp>();

// Atomic writes normally rename within milliseconds. Every cleanup path shares this grace
// period so none can race an in-flight session-store write.
export const SESSION_STORE_TEMP_STALE_MS = 5 * 60 * 1000;

function sessionStoreTempPattern(storeBasename: string): RegExp {
  let pattern = SESSION_STORE_TEMP_RE_CACHE.get(storeBasename);
  if (!pattern) {
    pattern = new RegExp(
      `^${escapeRegExp(storeBasename)}\\.(?:\\d+\\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
      "i",
    );
    SESSION_STORE_TEMP_RE_CACHE.set(storeBasename, pattern);
  }
  return pattern;
}

// Atomic writes of the session store stage into `<store>.<pid>.<uuid>.tmp`
// (legacy: `<store>.<uuid>.tmp`) and rename into place. A crash between write and
// rename orphans the temp; these accumulate and waste disk (#56827). They are
// never the live store, so a stale one is safe to reclaim. `storeBasename` is the
// store filename (the atomic write's temp prefix, e.g. `sessions.json`), so a
// custom-named `session.store` is matched too.
export function isSessionStoreTempArtifactName(fileName: string, storeBasename: string): boolean {
  if (!storeBasename) {
    return false;
  }
  return sessionStoreTempPattern(storeBasename).test(fileName);
}

export function isCompactionCheckpointTranscriptFileName(fileName: string): boolean {
  return COMPACTION_CHECKPOINT_TRANSCRIPT_RE.test(fileName);
}

function isTrajectoryRuntimeArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory.jsonl");
}

export function resolveTrajectoryPath(transcriptPath: string): string | undefined {
  return transcriptPath.endsWith(".jsonl")
    ? `${transcriptPath.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : undefined;
}

export function resolveTrajectoryPointerPath(transcriptPath: string): string | undefined {
  return transcriptPath.endsWith(".jsonl")
    ? `${transcriptPath.slice(0, -".jsonl".length)}.trajectory-path.json`
    : undefined;
}

export function isTrajectorySessionArtifactName(fileName: string): boolean {
  return isTrajectoryRuntimeArtifactName(fileName) || fileName.endsWith(".trajectory-path.json");
}

/** Returns true for primary session transcript files that represent live session history. */
export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  return (
    fileName.endsWith(".jsonl") &&
    !isTrajectoryRuntimeArtifactName(fileName) &&
    !isCompactionCheckpointTranscriptFileName(fileName)
  );
}

/** Returns true for transcript files counted in usage, including reset/deleted archives. */
export function isUsageCountedSessionTranscriptFileName(fileName: string): boolean {
  return parseUsageCountedSessionIdFromFileName(fileName) !== null;
}

export function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return fileName.slice(0, -".jsonl".length);
  }
  const normalized = stripSessionArchiveCompressionSuffix(fileName);
  for (const reason of ["reset", "deleted"] as const) {
    const marker = `.jsonl.${reason}.`;
    const index = normalized.lastIndexOf(marker);
    if (index > 0 && hasArchiveSuffix(normalized, reason)) {
      const sessionId = normalized.slice(0, index);
      return isPrimarySessionTranscriptFileName(`${sessionId}.jsonl`) ? sessionId : null;
    }
  }
  return null;
}

export function formatSessionArchiveTimestamp(nowMs = Date.now()): string {
  return timestampMsToIsoFileStamp(nowMs);
}

export function parseSessionArchiveTimestamp(
  fileName: string,
  reason: SessionArchiveReason,
): number | null {
  const timestampRaw = readSessionArchiveTimestamp(fileName, reason);
  if (!timestampRaw) {
    return null;
  }
  const timestamp = Date.parse(
    timestampRaw.slice(0, 11) + timestampRaw.slice(11).replace(/-/g, ":"),
  );
  return Number.isNaN(timestamp) ? null : timestamp;
}
