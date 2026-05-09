export type CaptureProtocol = "http" | "https" | "sse" | "ws" | "wss" | "connect";

export type CaptureDirection = "outbound" | "inbound" | "local";

export type CaptureEventKind =
  | "connect"
  | "tls-handshake"
  | "request"
  | "response"
  | "ws-open"
  | "ws-frame"
  | "ws-close"
  | "error"
  | "retry-link";

export type CaptureSessionRecord = {
  id: string;
  startedAt: number;
  endedAt?: number;
  mode: string;
  sourceScope: "openclaw";
  sourceProcess: string;
  proxyUrl?: string;
  dbPath: string;
  blobDir: string;
};

export type CaptureBlobRecord = {
  blobId: string;
  path: string;
  encoding: "gzip";
  sizeBytes: number;
  sha256: string;
  contentType?: string;
};

export type CaptureEventRecord = {
  sessionId: string;
  ts: number;
  sourceScope: "openclaw";
  sourceProcess: string;
  protocol: CaptureProtocol;
  direction: CaptureDirection;
  kind: CaptureEventKind;
  flowId: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  closeCode?: number;
  contentType?: string;
  headersJson?: string;
  dataText?: string;
  dataBlobId?: string;
  dataSha256?: string;
  errorText?: string;
  metaJson?: string;
};

export type CaptureQueryPreset =
  | "double-sends"
  | "retry-storms"
  | "cache-busting"
  | "ws-duplicate-frames"
  | "missing-ack"
  | "error-bursts";

export type CaptureQueryRowsByPreset = {
  "double-sends": {
    host: string | null;
    path: string | null;
    method: string | null;
    duplicateCount: number;
  };
  "retry-storms": {
    host: string | null;
    path: string | null;
    errorCount: number;
  };
  "cache-busting": {
    host: string | null;
    path: string | null;
    variantCount: number;
  };
  "ws-duplicate-frames": {
    host: string | null;
    path: string | null;
    duplicateFrames: number;
  };
  "missing-ack": {
    flowId: string;
    host: string | null;
    path: string | null;
    outboundFrames: number;
  };
  "error-bursts": {
    host: string | null;
    path: string | null;
    errorCount: number;
  };
};

export type CaptureQueryRow = CaptureQueryRowsByPreset[CaptureQueryPreset];

export type CaptureSessionSummary = {
  id: string;
  startedAt: number;
  endedAt?: number;
  mode: string;
  sourceProcess: string;
  proxyUrl?: string;
  eventCount: number;
};

export type CaptureObservedDimension = {
  value: string;
  count: number;
};

export type CaptureSessionCoverageSummary = {
  sessionId: string;
  totalEvents: number;
  unlabeledEventCount: number;
  providers: CaptureObservedDimension[];
  apis: CaptureObservedDimension[];
  models: CaptureObservedDimension[];
  hosts: CaptureObservedDimension[];
  localPeers: CaptureObservedDimension[];
};
