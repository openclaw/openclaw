import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseIncognitoIdentity,
} from "../../state/openclaw-agent-execution-identity.types.js";
import type { SessionMember, SessionParticipantRecord } from "./session-membership-facts.types.js";
import type { SessionPendingInputRow } from "./session-pending-input.types.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWatermark,
} from "./session-transcript-context-version.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionActorTarget = Readonly<{
  database:
    | AgentDatabaseExecutionFileIdentity
    | AgentDatabaseIncognitoIdentity
    | { kind: "memory"; handle: string; incarnation: string };
  sessionKey: string;
}>;

/** Sequences are comparable only within one owner epoch. Rehydration creates a new epoch. */
export type SessionActorVersion = Readonly<{ epoch: string; sequence: number }>;

export type SessionActorLifetime = {
  /** Refuse new work without revoking already accepted settlement. */
  assertAdmission?(): void;
  assertCurrent(): void;
  /** Accepted work may still settle after new disclosure has been revoked. */
  assertReadable(): void;
};

/** Entry policy and physical/version identity; transcript indexes are not authority. */
export type SessionActorAuthorityFacts = Pick<
  SessionActorHotState,
  "target" | "version" | "writeToken" | "dependencySessionIds" | "entry"
>;

/** Host-owned live authority, rechecked at both synchronous admission boundaries. */
export type SessionActorAuthority = {
  assertCurrent(): void;
  authorize(
    stage: "transaction" | "commit",
    facts: SessionActorAuthorityFacts,
    /** Existing kernel source/custody evidence remains subject to its owner's checks. */
    publication?: unknown,
  ): void;
};

/** Complete hot facts. Cold/off-path payloads stay with the bounded history reader. */
export type SessionActorHotState = {
  target: SessionActorTarget;
  version: SessionActorVersion;
  /** In-process writer receipt revision, not a SQLite foreign-commit observation. */
  writeToken: string;
  /** Shared windows retained by the selected row and its lookup aliases. */
  dependencySessionIds: string[];
  /** Includes the canonical turn, lifecycle, recovery, and pendingFinalDelivery fields. */
  entry: SessionEntry | undefined;
  hasBoard: boolean;
  participants: SessionParticipantRecord[];
  members: SessionMember[];
  pendingInputs: Array<Omit<SessionPendingInputRow, "message_json">>;
  /** Complete retry-key membership; outcome bodies stay in the worker. */
  completionKeys: string[];
  transcript: {
    watermark: SessionTranscriptWatermark;
    version: SessionTranscriptContextVersion;
    /** Empty anchors prove absence only when this exact projection is resident. */
    anchorsState: "resident" | "unavailable";
    anchors: TranscriptEntryAnchor[];
    idempotency: Array<{ key: string; eventId: string; rawSeq: number }>;
    /** Exact ordered active context membership, including an explicitly empty context. */
    modelContext:
      | { kind: "resident"; entries: Array<{ rawSeq: number; eventId: string | null }> }
      | { kind: "unavailable"; reason: "cold" | "projection"; generation: string | null };
  };
};

export type SessionActorSettlement = "committed" | "rolled-back" | "unknown";
