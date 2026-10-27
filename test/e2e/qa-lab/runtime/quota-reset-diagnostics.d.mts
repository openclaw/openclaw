import type { Buffer } from "node:buffer";

type Phase = "healthy" | "initial-exhaustion" | "restored" | "other";
type Transport = "http" | "websocket" | "unknown";
type Endpoint = "unknown" | "oauth-token" | "catalog" | "usage" | "responses" | "other";
type RequestMode = "warmup" | "inference" | "unknown";
type Timed = { atMs: number | null };
type RequestDiagnostic = Timed & {
  phase: Phase;
  transport: Transport;
  endpoint: Endpoint;
};

type PublicDiagnostics = {
  schemaVersion: 2;
  omitted: {
    requests: number;
    upgrades: number;
    refreshes: number;
    nativeAuth: number;
    responses: number;
    handshakeFailures: number;
  };
  refreshReceiptAvailable: boolean;
  authCaptureTruncated: boolean;
  nativeLogAvailable: boolean;
  profile: {
    status: "ok" | "expiring" | "expired" | "missing" | "static" | "unknown";
    expiresAt: number | null;
    remainingMs: number | null;
  };
  requests: RequestDiagnostic[];
  upgrades: (Timed & { endpoint: Endpoint })[];
  refreshes: Timed[];
  nativeAuth: (
    | (Timed & {
        kind: "refresh";
        method: "account/chatgptAuthTokens/refresh";
        reason: "unauthorized" | "unknown";
      })
    | (Timed & {
        kind: "observer-attached";
        method: null;
        reason: "unauthorized" | "unknown";
      })
  )[];
  responses: (RequestDiagnostic & {
    status: number | null;
    statusClass: "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "unknown";
    mode: RequestMode;
  })[];
  handshakeFailures: (
    | { kind: "http"; httpStatus: number }
    | { kind: "unknown"; httpStatus: null }
  )[];
};

export function createQuotaNativeAuthObserver(
  write: (event: { kind: "native-refresh"; reason: "unauthorized" | "unknown" }) => void,
): (chunk: Buffer | string) => void;

export function quotaRequestMode(body: unknown): RequestMode;

export function quotaPublicDiagnostics(input: unknown): PublicDiagnostics;
