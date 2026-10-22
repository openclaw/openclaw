export const SESSION_ARCHIVE_ZSTD_SUFFIX = ".zst";

/** Strips the optional zstd suffix so archive name parsers see one shape. */
function stripSessionArchiveCompressionSuffix(fileName: string): string {
  return fileName.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)
    ? fileName.slice(0, -SESSION_ARCHIVE_ZSTD_SUFFIX.length)
    : fileName;
}

export type SessionArchiveReason = "bak" | "reset" | "deleted";

const ARCHIVE_SUFFIX_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z)(?:\.([0-9a-f]{32}))?$/;

const COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

export function readSessionArchiveTimestamp(
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

export function hasArchiveSuffix(fileName: string, reason: SessionArchiveReason): boolean {
  return readSessionArchiveTimestamp(fileName, reason) !== undefined;
}

export function isCompactionCheckpointTranscriptFileName(fileName: string): boolean {
  return COMPACTION_CHECKPOINT_TRANSCRIPT_RE.test(fileName);
}

export function isTrajectoryRuntimeArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory.jsonl");
}

/** Returns true for primary session transcript files that represent live session history. */
export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  return (
    fileName.endsWith(".jsonl") &&
    !isTrajectoryRuntimeArtifactName(fileName) &&
    !isCompactionCheckpointTranscriptFileName(fileName)
  );
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
