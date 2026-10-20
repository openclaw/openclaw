export type UnindexedTranscriptNavigation = {
  event_seq: number;
  event: Record<string, unknown>;
  serialized_bytes: number;
};

export type UnindexedActiveTranscriptNavigation = UnindexedTranscriptNavigation & {
  active_position: number;
  message_position: number | null;
};

export type UnindexedHistoryControl = UnindexedActiveTranscriptNavigation & {
  following_message_position: number | null;
};
