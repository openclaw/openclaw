export type SessionArchiveReason = "bak" | "reset" | "deleted";

const ISO_ARCHIVE_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}-\d{2})$/;
const COMPACT_ARCHIVE_TIMESTAMP_RE = /^\d{8}-\d{6}$/;
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;

function isArchiveTimestamp(raw: string): boolean {
  return ISO_ARCHIVE_TIMESTAMP_RE.test(raw) || COMPACT_ARCHIVE_TIMESTAMP_RE.test(raw);
}

function hasArchiveSuffix(fileName: string, reason: SessionArchiveReason): boolean {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return false;
  }
  const raw = fileName.slice(index + marker.length);
  return isArchiveTimestamp(raw);
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

export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  if (fileName === "sessions.json") {
    return false;
  }
  if (!fileName.endsWith(".jsonl")) {
    return false;
  }
  return !isSessionArchiveArtifactName(fileName);
}

export function isUsageCountedSessionTranscriptFileName(fileName: string): boolean {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return true;
  }
  return hasArchiveSuffix(fileName, "reset") || hasArchiveSuffix(fileName, "deleted");
}

export function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return fileName.slice(0, -".jsonl".length);
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
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  }

  const iso = raw.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d{3})?(Z|[+-]\d{2}-\d{2})$/,
  );
  if (iso) {
    const [, datePart, hour, minute, second, millis = "", zone] = iso;
    const normalizedZone = zone === "Z" ? "Z" : zone.replace(/([+-]\d{2})-(\d{2})$/, "$1:$2");
    return `${datePart}T${hour}:${minute}:${second}${millis}${normalizedZone}`;
  }
  return raw;
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
  if (!isArchiveTimestamp(raw)) {
    return null;
  }
  const timestamp = Date.parse(restoreSessionArchiveTimestamp(raw));
  return Number.isNaN(timestamp) ? null : timestamp;
}
