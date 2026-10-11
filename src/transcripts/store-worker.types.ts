/** Host-only capture scheduling; functions never cross the worker boundary. */
export type TranscriptAppendScheduler = (
  write: (assertCurrent: () => void) => Promise<void>,
) => Promise<void>;

export type TranscriptExportWriteKey =
  | "transcripts.markPendingExports"
  | "transcripts.recordExportManifest";
