import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { createTranscriptIdentityReader } from "./session-accessor.sqlite-read.js";
import type { createTranscriptIdentityInserter } from "./session-accessor.sqlite-transcript-identity.js";
import type { createTranscriptIndexAppenderInTransaction } from "./session-transcript-index.js";
import type {
  createTranscriptEventInserter,
  PreparedTranscriptPayload,
} from "./transcript-payload.js";

export type TranscriptInsertRow = {
  event: TranscriptEvent;
  seq: number;
  createdAt: number;
  messageIdempotencyKey?: string | null;
  storedEventSeq?: number;
};

export type TranscriptAppendOptions = {
  /** Exact event bytes, including canonical media, prepared by the message append owner. */
  eventJson?: string;
  preparedPayload?: PreparedTranscriptPayload;
  allowStoredAlias?: boolean;
  onPlaceholderInserted?: (placeholder: { sessionKey: string; sessionId: string }) => void;
  idempotencyKeyMode?: "dedupe" | "preserve-owner" | "relocate-owner";
  onProjectionReconcileNeeded?: () => void;
  scheduleProjectionReconcile?: boolean;
  touchMutation?: boolean;
};

export type TranscriptAppendCursor = {
  initialized?: boolean;
  readIdentity?: ReturnType<typeof createTranscriptIdentityReader>;
  nextSeq?: number;
  appendToIndex?: ReturnType<typeof createTranscriptIndexAppenderInTransaction>;
  updateWindow?: (createdAt: number) => unknown;
  insertEvent?: ReturnType<typeof createTranscriptEventInserter>;
  insertIdentity?: ReturnType<typeof createTranscriptIdentityInserter>;
};
