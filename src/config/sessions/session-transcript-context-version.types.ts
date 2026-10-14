export type SessionTranscriptWatermark = {
  generation: string | null;
  maxSeq: number | null;
};

export type SessionTranscriptContextVersion = {
  generation: string | null;
  rawSeq: number | null;
  updatedAt: number | null;
};
