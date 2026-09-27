import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayConnectionDetails } from "./connection-details.js";

export type GatewayTransportErrorKind = "closed" | "timeout";

export class GatewayTransportError extends Error {
  readonly kind: GatewayTransportErrorKind;
  readonly connectionDetails: GatewayConnectionDetails;
  readonly code?: number;
  readonly reason?: string;
  readonly timeoutMs?: number;

  constructor(params: {
    kind: GatewayTransportErrorKind;
    message: string;
    connectionDetails: GatewayConnectionDetails;
    code?: number;
    reason?: string;
    timeoutMs?: number;
  }) {
    super(params.message);
    this.name = "GatewayTransportError";
    this.kind = params.kind;
    this.connectionDetails = params.connectionDetails;
    if (params.code !== undefined) {
      this.code = params.code;
    }
    if (params.reason !== undefined) {
      this.reason = params.reason;
    }
    if (params.timeoutMs !== undefined) {
      this.timeoutMs = params.timeoutMs;
    }
  }
}

export function isGatewayTransportError(value: unknown): value is GatewayTransportError {
  if (value instanceof GatewayTransportError) {
    return true;
  }
  if (!(value instanceof Error) || value.name !== "GatewayTransportError") {
    return false;
  }
  return (
    "kind" in value &&
    (value.kind === "closed" || value.kind === "timeout") &&
    "connectionDetails" in value &&
    typeof value.connectionDetails === "object" &&
    value.connectionDetails !== null
  );
}

const DISPATCHED_REQUEST_OUTCOME_GUIDANCE =
  "The request was already sent to the gateway, so the operation may have been applied " +
  "even though no response arrived; its outcome is unknown. " +
  "Verify the current state (for example, re-run the equivalent read-only command) " +
  "before retrying, especially for write actions.";

export function createGatewayCloseTransportError(params: {
  code: number;
  reason: string;
  connectionDetails: GatewayConnectionDetails;
  requestDispatched: boolean;
}): GatewayTransportError {
  const { code, connectionDetails, requestDispatched } = params;
  const reason = normalizeOptionalString(params.reason) || "no close reason";
  const hint =
    code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
  const suffix = hint ? ` ${hint}` : "";
  let message = `gateway closed (${code}${suffix}): ${reason}\n${connectionDetails.message}`;
  if (code === 1006) {
    // A completed handshake cannot explain a close after request dispatch.
    const connectionHints = requestDispatched
      ? "- Connection dropped without a close frame (check network and gateway load)"
      : "- Connection dropped without a close frame (retry; check network and gateway load)" +
        "\n- Gateway not yet ready to accept connections (retry after a moment)" +
        "\n- TLS mismatch (connecting with ws:// to a wss:// gateway, or vice versa)";
    message +=
      `\n\nPossible causes:\n${connectionHints}` +
      "\n- Gateway process stopped or became unreachable (confirm it is still running)" +
      "\nRun `openclaw doctor` for diagnostics.";
  }
  return new GatewayTransportError({
    kind: "closed",
    code,
    reason,
    connectionDetails,
    message: requestDispatched ? `${message}\n\n${DISPATCHED_REQUEST_OUTCOME_GUIDANCE}` : message,
  });
}

export function createGatewayTimeoutTransportError(params: {
  timeoutMs: number;
  connectionDetails: GatewayConnectionDetails;
  requestDispatched: boolean;
}): GatewayTransportError {
  const { timeoutMs, connectionDetails, requestDispatched } = params;
  const message = `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
  return new GatewayTransportError({
    kind: "timeout",
    timeoutMs,
    connectionDetails,
    message: requestDispatched ? `${message}\n\n${DISPATCHED_REQUEST_OUTCOME_GUIDANCE}` : message,
  });
}

/** Transport uncertainty permits read recovery or an exclusively ownership-locked mutation. */
export function isGatewayRpcUnavailableError(error: unknown): boolean {
  if (isGatewayTransportError(error)) {
    return error.kind === "timeout" || [undefined, 1006, 1012].includes(error.code);
  }
  // Pending protocol requests still surface these exact transport failures as plain Errors.
  return (
    error instanceof Error &&
    error.name === "Error" &&
    (/^gateway closed \((?:1006|1012)\): [^\r\n]*$/u.test(error.message) ||
      /^gateway timeout after \d+ms(?:\n[\s\S]*)?$/u.test(error.message))
  );
}
