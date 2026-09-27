import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/**
 * Read-only upgrade contract for pre-removal session metadata. Historical transcript
 * references still protect stored generations/files from existing cleanup, and old
 * token measurements still enrich history. No runtime writes new checkpoints.
 * Remove only after an explicitly approved migration has preserved those facts.
 */
type LegacyCompactionHistory = {
  sessionId?: string;
  preCompaction: { sessionId?: string; sessionFile?: string };
  postCompaction: { sessionId?: string; sessionFile?: string; entryId?: string };
  tokensBefore?: number;
  tokensAfter?: number;
};

export function readLegacyCompactionSnapshotPaths(entry: unknown): string[] {
  return readLegacyCompactionHistory(entry).flatMap((checkpoint) =>
    [
      checkpoint.preCompaction.sessionFile?.trim(),
      checkpoint.postCompaction.sessionFile?.trim(),
    ].filter((filePath): filePath is string => Boolean(filePath)),
  );
}

export function readLegacyCompactionHistory(entry: unknown): readonly LegacyCompactionHistory[] {
  const checkpoints = asOptionalRecord(entry)?.compactionCheckpoints;
  if (checkpoints == null) {
    return [];
  }
  // Malformed references must fail closed, not make protected history reclaimable.
  if (!Array.isArray(checkpoints)) {
    throw new TypeError("Invalid legacy compaction history references");
  }
  return checkpoints.map((checkpoint): LegacyCompactionHistory => {
    const record = asOptionalRecord(checkpoint);
    const pre = asOptionalRecord(record?.preCompaction);
    const post = asOptionalRecord(record?.postCompaction);
    if (!record || !pre || !post) {
      throw new TypeError("Invalid legacy compaction history references");
    }
    const string = (value: unknown): string | undefined => {
      if (value == null) {
        return undefined;
      }
      if (typeof value !== "string") {
        throw new TypeError("Invalid legacy compaction history reference");
      }
      return value;
    };
    const number = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    return {
      sessionId: string(record.sessionId),
      preCompaction: { sessionId: string(pre.sessionId), sessionFile: string(pre.sessionFile) },
      postCompaction: {
        sessionId: string(post.sessionId),
        sessionFile: string(post.sessionFile),
        entryId: string(post.entryId),
      },
      tokensBefore: number(record.tokensBefore),
      tokensAfter: number(record.tokensAfter),
    };
  });
}
