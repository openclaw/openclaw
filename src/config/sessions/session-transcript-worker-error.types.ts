import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import type { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";

export type SessionTranscriptWorkerReadError =
  | { kind: "read-error"; message: string; payload: OpenClawStateWorkerErrorPayload }
  | { kind: "cold"; sessionId: string }
  | { kind: "projection"; sessionId: string }
  | { kind: "fence"; message: string }
  | { kind: "syntax"; message: string }
  | { kind: "storage"; reason?: SessionTranscriptStorageUnavailableError["reason"] };
