import type {
  WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";

const SIZE_FRAME_ID = "00000000-0000-4000-8000-000000000000";

export function isWorkerTranscriptMessageFrameSafe(message: WorkerTranscriptMessage): boolean {
  const frame: WorkerTranscriptCommitRequestFrame = {
    type: "req",
    id: SIZE_FRAME_ID,
    method: "worker.transcript.commit",
    params: {
      runEpoch: Number.MAX_SAFE_INTEGER,
      seq: Number.MAX_SAFE_INTEGER,
      baseLeafId: "x".repeat(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH),
      messages: [message],
    },
  };
  try {
    return Buffer.byteLength(JSON.stringify(frame), "utf8") <= WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}
