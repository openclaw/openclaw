import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";

/** A reset identity is ordered only within the same transcript generation. */
export type SessionTranscriptResetBoundary = Readonly<{
  entryId: string;
  rawSeq: number;
  generation: string | null;
}>;

export type SessionTranscriptEligibleEntry = Readonly<{
  entryId: string;
  parentId: string | null;
  /** Canonical raw event sequence, not an ingestion cursor. */
  seq: number;
  message: AgentMessage;
  createdAt: string;
}>;

export type SessionTranscriptAdmissionRead =
  | { kind: "missing" }
  | { kind: "stale" }
  | {
      kind: "snapshot";
      entries: SessionTranscriptEligibleEntry[];
      boundary: SessionTranscriptResetBoundary | null;
      version: SessionTranscriptContextVersion;
      lifecycleRevision: string | null;
      databaseIdentity: string;
      databaseBirthtime: string | undefined;
    };
