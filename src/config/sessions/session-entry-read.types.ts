import type {
  SessionEntryReadScope,
  SessionTranscriptRuntimeScope,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryReadWorkerInput = {
  kind: "session-entry-read";
  database: { agentId: string; path: string };
  scope: SessionEntryReadScope & { databaseAgentId: string };
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionEntryReadWorkerResult = {
  kind: "session-entry-read";
  source?: CapturedSessionEntryReadSource & { databaseIdentity: string };
} & (
  | { entry: SessionEntry | undefined; readError?: never }
  | { entry: undefined; readError: SessionTranscriptWorkerReadError }
);

export type SessionRuntimeTargetWorkerInput = {
  kind: "session-runtime-target";
  database: { agentId: string; path: string };
  scope: SessionTranscriptRuntimeScope & { agentId: string; storePath: string };
  keyFormat?: "agent-qualified";
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionRuntimeTargetWorkerResult = {
  kind: "session-runtime-target";
  source?: CapturedSessionEntryReadSource & { databaseIdentity: string };
  target: Awaited<
    ReturnType<
      typeof import("./session-accessor.transcript-target.js").resolveSessionTranscriptRuntimeTarget
    >
  >;
};
