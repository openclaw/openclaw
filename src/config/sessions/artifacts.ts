export type SessionArchiveReason = "bak" | "reset" | "deleted";

const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;
const COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

// Anchored at end of file name: literal `.checkpoint.` + UUID-v4 shape + `.jsonl`.
// Session IDs that happen to contain the substring "checkpoint" (with any suffix
// shape) do NOT match because the UUID regex requires the exact `[0-9a-f]{8}-…`
// shape immediately after `.checkpoint.` and `.jsonl` immediately after that.
const CHECKPOINT_MARKER_RE =
  /\.checkpoint\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function hasArchiveSuffix(fileName: string, reason: SessionArchiveReason): boolean {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return false;
  }
  const raw = fileName.slice(index + marker.length);
  return ARCHIVE_TIMESTAMP_RE.test(raw);
}

export function isSessionArchiveArtifactName(fileName: string): boolean {
  if (LEGACY_STORE_BACKUP_RE.test(fileName)) {
    return true;
  }
  return (
    hasArchiveSuffix(fileName, "deleted") ||
    hasArchiveSuffix(fileName, "reset") ||
    hasArchiveSuffix(fileName, "bak")
  );
}

export function parseCompactionCheckpointTranscriptFileName(fileName: string): {
  sessionId: string;
  checkpointId: string;
} | null {
  const match = COMPACTION_CHECKPOINT_TRANSCRIPT_RE.exec(fileName);
  const sessionId = match?.[1];
  const checkpointId = match?.[2];
  return sessionId && checkpointId ? { sessionId, checkpointId } : null;
}

export function isCompactionCheckpointTranscriptFileName(fileName: string): boolean {
  return parseCompactionCheckpointTranscriptFileName(fileName) !== null;
}

export function isTrajectoryRuntimeArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory.jsonl");
}

export function isTrajectoryPointerArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory-path.json");
}

export function isTrajectorySessionArtifactName(fileName: string): boolean {
  return isTrajectoryRuntimeArtifactName(fileName) || isTrajectoryPointerArtifactName(fileName);
}

export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  if (fileName === "sessions.json") {
    return false;
  }
  if (!fileName.endsWith(".jsonl")) {
    return false;
  }
  if (isTrajectoryRuntimeArtifactName(fileName)) {
    return false;
  }
  if (isCheckpointSessionTranscriptFileName(fileName)) {
    return false;
  }
  return !isSessionArchiveArtifactName(fileName);
}

export function isUsageCountedSessionTranscriptFileName(fileName: string): boolean {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return true;
  }
  if (isCheckpointSessionTranscriptFileName(fileName)) {
    return true;
  }
  return hasArchiveSuffix(fileName, "reset") || hasArchiveSuffix(fileName, "deleted");
}

/**
 * Classify pre-compaction checkpoint-twin transcript files, e.g.
 * `<parentId>.checkpoint.<uuid>.jsonl`. Uses an anchored UUID-shape match so
 * session IDs that happen to contain the substring "checkpoint" do not
 * false-positive.
 */
export function isCheckpointSessionTranscriptFileName(fileName: string): boolean {
  return CHECKPOINT_MARKER_RE.test(fileName);
}

/**
 * Extract the parent session id from a checkpoint transcript file name. The
 * parent session id is the part BEFORE `.checkpoint.<uuid>.jsonl`; it matches
 * what `isPrimarySessionTranscriptFileName` expects when the parent primary
 * exists as `<parentId>.jsonl`. Returns `null` if the file is not a checkpoint.
 */
export function parseParentSessionIdFromCheckpointFileName(fileName: string): string | null {
  const match = fileName.match(CHECKPOINT_MARKER_RE);
  if (!match || match.index === undefined) {
    return null;
  }
  return fileName.slice(0, match.index);
}

export function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return fileName.slice(0, -".jsonl".length);
  }
  const checkpointParentId = parseParentSessionIdFromCheckpointFileName(fileName);
  if (checkpointParentId) {
    return checkpointParentId;
  }
  for (const reason of ["reset", "deleted"] as const) {
    const marker = `.jsonl.${reason}.`;
    const index = fileName.lastIndexOf(marker);
    if (index > 0 && hasArchiveSuffix(fileName, reason)) {
      return fileName.slice(0, index);
    }
  }
  return null;
}

export function formatSessionArchiveTimestamp(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().replaceAll(":", "-");
}

function restoreSessionArchiveTimestamp(raw: string): string {
  const [datePart, timePart] = raw.split("T");
  if (!datePart || !timePart) {
    return raw;
  }
  return `${datePart}T${timePart.replace(/-/g, ":")}`;
}

export function parseSessionArchiveTimestamp(
  fileName: string,
  reason: SessionArchiveReason,
): number | null {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const raw = fileName.slice(index + marker.length);
  if (!raw) {
    return null;
  }
  if (!ARCHIVE_TIMESTAMP_RE.test(raw)) {
    return null;
  }
  const timestamp = Date.parse(restoreSessionArchiveTimestamp(raw));
  return Number.isNaN(timestamp) ? null : timestamp;
}
