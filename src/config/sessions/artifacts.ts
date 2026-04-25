export type SessionArchiveReason = "bak" | "reset" | "deleted";

const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
const STORE_BACKUP_ARTIFACT_RE = /^sessions\.json\.bak\..+$/;

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
  if (STORE_BACKUP_ARTIFACT_RE.test(fileName)) {
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
