import type { SessionRowTranscriptProjection } from "../../gateway/session-row-transcript-preview.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { createTranscriptIdentityReader } from "./session-accessor.sqlite-read.js";
import type { createTranscriptIdentityInserter } from "./session-accessor.sqlite-transcript-identity.js";
import type { readTranscriptAppendStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { createTranscriptIndexAppenderInTransaction } from "./session-transcript-index.js";
import type {
  createTranscriptEventInserter,
  PreparedTranscriptPayload,
  TranscriptEventInsertRow,
  TranscriptIdentityInsertRow,
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
  /** Message turns preserve the independent appender's assistant projection sentinel. */
  independentMessageProjection?: boolean;
  /** Keep logical actor snapshots while a later required append persists the watermark. */
  persistActorMutation?: boolean;
};

export type TranscriptAppendCursor = {
  deferWrites?: boolean;
  windowUpdatedAt?: number;
  rowTranscript?: SessionRowTranscriptProjection;
  initialized?: boolean;
  initialState?: ReturnType<typeof readTranscriptAppendStateInTransaction>;
  /** Generation read under this append's transaction lock. */
  generation?: string;
  readIdentity?: ReturnType<typeof createTranscriptIdentityReader>;
  nextSeq?: number;
  appendToIndex?: ReturnType<typeof createTranscriptIndexAppenderInTransaction>;
  updateWindow?: (createdAt: number) => unknown;
  insertEvent?: ReturnType<typeof createTranscriptEventInserter>;
  insertIdentity?: ReturnType<typeof createTranscriptIdentityInserter>;
  batch?: {
    events: TranscriptEventInsertRow[];
    identities: Map<string, TranscriptIdentityInsertRow>;
    knownEventIds: Set<string>;
    keyOwners: Map<string, { eventId: string; seq: number } | undefined>;
    preparedArray: boolean;
    bytes: number;
  };
};
