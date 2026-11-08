/** Internal continuity facts for history pages read in separate SQLite snapshots. */
export type TranscriptReadWindow = {
  source: string | undefined;
  latestResetRawSeq: number | null;
  anchor?: { rawSeq: number; seq: number };
};

export type TranscriptReadWindowOptions = {
  captureReadWindow?: boolean;
  expectedReadWindow?: TranscriptReadWindow;
};
