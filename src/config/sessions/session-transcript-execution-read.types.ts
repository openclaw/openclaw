import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type {
  SessionMemoryCaptureWorkerInput,
  SessionTranscriptAnchorsWorkerInput,
  SessionTranscriptDeltaWorkerInput,
  SessionTranscriptWatermarkWorkerInput,
} from "./session-transcript-worker-read.types.js";

type CapturedRead<Input> = Omit<Input, "kind" | "database" | "expectedIdentity"> & {
  expectedIdentity: DatabaseFileIdentity;
};

export type SessionTranscriptExecutionReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionTranscriptWorkerReadError };

export type SessionTranscriptExecutionReadInputs = {
  raw: CapturedRead<Extract<SessionTranscriptDeltaWorkerInput, { kind: "transcript-raw-delta" }>>;
  visible: CapturedRead<
    Extract<SessionTranscriptDeltaWorkerInput, { kind: "transcript-visible-delta" }>
  >;
  memory: CapturedRead<SessionMemoryCaptureWorkerInput>;
  anchors: CapturedRead<SessionTranscriptAnchorsWorkerInput>;
  watermark: CapturedRead<SessionTranscriptWatermarkWorkerInput>;
  cold: { sessionId: string; expectedIdentity: DatabaseFileIdentity };
};
