import {
  MAX_BUFFERED_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PREAUTH_PAYLOAD_BYTES,
} from "../server-constants.js";

export const OPERATOR_HTTP_LIMITS = Object.freeze({
  maxPreauthPayloadBytes: MAX_PREAUTH_PAYLOAD_BYTES,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
  maxBufferedBytes: MAX_BUFFERED_BYTES,
  maxQueuedFrames: 256,
  maxBatchFrames: 64,
  maxPollWaitMs: 25_000,
  idleTimeoutMs: 60_000,
  maxConnections: 256,
});

export type OperatorHttpBeginResponse = {
  connectionId: string;
  connectionKey: string;
  challenge: { nonce: string; ts: number };
  handshakeExpiresAtMs: number;
  limits: typeof OPERATOR_HTTP_LIMITS;
};

export type OperatorHttpFramesRequest = { clientSeq: number; ack: number; frame: unknown };
export type OperatorHttpFramesResponse = { acceptedClientSeq: number };
export type OperatorHttpPollRequest = { ack: number; waitMs: number };
export type OperatorHttpClosed = { code: number; reason: string; resyncRequired: true };
export type OperatorHttpPollResponse = {
  acceptedClientSeq: number;
  frames: Array<{ cursor: number; frame: unknown }>;
  closed?: OperatorHttpClosed;
};

export type OperatorHttpErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "https_required"
  | "ingress_changed"
  | "connection_not_found"
  | "connection_closed"
  | "sequence_conflict"
  | "ack_conflict"
  | "poll_conflict"
  | "payload_too_large"
  | "request_timeout"
  | "connection_limit"
  | "unavailable"
  | "method_not_allowed";
export type OperatorHttpErrorResponse = {
  error: { code: OperatorHttpErrorCode; message: string; resyncRequired?: true };
};
