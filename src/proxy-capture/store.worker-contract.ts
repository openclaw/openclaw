import type {
  CaptureEventRecord,
  CaptureQueryPreset,
  CaptureQueryRow,
  CaptureSessionCoverageSummary,
  CaptureSessionRecord,
  CaptureSessionSummary,
  SharedCaptureBlobRecord,
} from "./types.js";

export type CapturePayloadInput = {
  data?: Buffer | string | null;
  contentType?: string;
  previewLimit?: number;
};

type CaptureDeleteResult = { sessions: number; events: number; blobs: number };

export type CaptureWorkerOperations = {
  "capture.upsertSession": { input: CaptureSessionRecord; output: void };
  "capture.endSession": { input: { sessionId: string; endedAt: number }; output: void };
  "capture.persistPayload": {
    input: { data: Buffer; contentType?: string };
    output: SharedCaptureBlobRecord;
  };
  "capture.recordEvent": { input: CaptureEventRecord; output: void };
  "capture.recordEventWithPayload": {
    input: { event: CaptureEventRecord; payload: CapturePayloadInput };
    output: void;
  };
  "capture.listSessions": { input: { limit?: number }; output: CaptureSessionSummary[] };
  "capture.getSessionEvents": {
    input: { sessionId: string; limit?: number };
    output: Array<Record<string, unknown>>;
  };
  "capture.summarizeSessionCoverage": {
    input: { sessionId: string };
    output: CaptureSessionCoverageSummary;
  };
  "capture.readBlob": { input: { blobId: string }; output: string | null };
  "capture.queryPreset": {
    input: { preset: CaptureQueryPreset; sessionId?: string };
    output: CaptureQueryRow[];
  };
  "capture.deleteSessions": { input: { sessionIds: string[] }; output: CaptureDeleteResult };
  "capture.purgeAll": { input: undefined; output: CaptureDeleteResult };
};
