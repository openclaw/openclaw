import type { CapturePayloadInput, CaptureWorkerOperations } from "./store.worker-contract.js";
import type {
  CaptureEventRecord,
  CaptureQueryPreset,
  CaptureQueryRow,
  CaptureSessionCoverageSummary,
  CaptureSessionRecord,
  CaptureSessionSummary,
  SharedCaptureBlobRecord,
} from "./types.js";

type CaptureDeleteResult = CaptureWorkerOperations["capture.purgeAll"]["output"];

export type AsyncDebugProxyCaptureStore = {
  readonly dbPath: string;
  readonly isClosed: boolean;
  upsertSession(session: CaptureSessionRecord): Promise<void>;
  endSession(sessionId: string, endedAt?: number): Promise<void>;
  persistPayload(data: Buffer, contentType?: string): Promise<SharedCaptureBlobRecord>;
  recordEvent(event: CaptureEventRecord): Promise<void>;
  recordEventWithPayload(event: CaptureEventRecord, payload: CapturePayloadInput): Promise<void>;
  listSessions(limit?: number): Promise<CaptureSessionSummary[]>;
  getSessionEvents(sessionId: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  summarizeSessionCoverage(sessionId: string): Promise<CaptureSessionCoverageSummary>;
  readBlob(blobId: string): Promise<string | null>;
  queryPreset(preset: CaptureQueryPreset, sessionId?: string): Promise<CaptureQueryRow[]>;
  deleteSessions(sessionIds: string[]): Promise<CaptureDeleteResult>;
  purgeAll(): Promise<CaptureDeleteResult>;
  close(): Promise<void>;
};
