import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  GatewayProtocolRequestError,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  readConnectErrorDetailCode,
  shouldPauseGatewayReconnect,
  type ErrorShape,
  type GatewayProtocolCloseContext,
} from "@openclaw/gateway-client/browser";
import { isLoopbackHostname } from "../lib/gateway-locality.ts";
import {
  BROWSER_WEBSOCKET_SECURITY_ERROR_CODE,
  formatBrowserWebSocketConstructorError,
} from "./gateway-browser-socket.ts";

export type GatewayBrowserCloseInfo = {
  code: number;
  reason: string;
  error?: ErrorShape;
  willRetry: boolean;
  busy?: boolean;
};

export class GatewayRequestError extends GatewayProtocolRequestError {
  constructor(error: ErrorShape) {
    const details = enrichProtocolMismatchDetails(error.message, error.details);
    super({
      ...error,
      details,
      message: formatConnectErrorMessage({ message: error.message, details }),
    });
    this.name = "GatewayRequestError";
  }
}

export function toGatewayErrorInfo(error: GatewayRequestError): ErrorShape {
  const { gatewayCode: code, message, details, retryable, retryAfterMs } = error;
  return { code, message, details, retryable, retryAfterMs };
}

export function isTrustedRetryEndpoint(url: string): boolean {
  try {
    const gatewayUrl = new URL(url, window.location.href);
    return (
      isLoopbackHostname(gatewayUrl.hostname) ||
      gatewayUrl.host === new URL(window.location.href).host
    );
  } catch {
    return false;
  }
}

export function resolveBrowserGatewayClose(
  context: GatewayProtocolCloseContext,
  nativeAuthError: GatewayRequestError | null,
  pairingFailure: GatewayRequestError | null,
  pendingDeviceTokenRetry: boolean,
) {
  if (nativeAuthError) {
    return {
      retry: nativeAuthError.retryable,
      notify: true,
      pendingError: nativeAuthError,
    };
  }
  const error = pairingFailure ?? context.connectFailure?.error;
  const startupDelay = context.connectFailure?.reconnectDelayMs;
  if (startupDelay !== undefined) {
    return { retry: true, notify: true, reconnectDelayMs: startupDelay, pendingError: error };
  }
  const connectError = error instanceof GatewayRequestError ? toGatewayErrorInfo(error) : undefined;
  const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
  // This decision drives both scheduling and the store's reconnect rendering.
  const retry =
    connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
      ? pendingDeviceTokenRetry
      : !shouldPauseGatewayReconnect({
          details: connectError?.details,
          protocolMismatchIsTerminal: true,
        });
  return { retry, notify: true, pendingError: error };
}

export function notifyBrowserWebSocketError(
  error: Error,
  opts: { url: string; onClose?: (info: GatewayBrowserCloseInfo) => void },
): void {
  const formatted = formatBrowserWebSocketConstructorError(error, opts.url);
  try {
    opts.onClose?.({
      code: 1006,
      reason:
        formatted.code === BROWSER_WEBSOCKET_SECURITY_ERROR_CODE
          ? "security error"
          : "websocket error",
      error: formatted,
      willRetry: false,
    });
  } catch (callbackError) {
    console.error("[gateway] close handler error:", callbackError);
  }
}

function enrichProtocolMismatchDetails(message: string | undefined, details: unknown): unknown {
  if (readConnectErrorDetailCode(details) === ConnectErrorDetailCodes.PROTOCOL_MISMATCH) {
    return details;
  }
  if (!message?.toLowerCase().includes("protocol mismatch")) {
    return details;
  }
  return {
    code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    clientMinProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    clientMaxProtocol: PROTOCOL_VERSION,
    ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
  };
}

export function resolveGatewayErrorDetailCode(
  error: { details?: unknown } | null | undefined,
): string | null {
  return readConnectErrorDetailCode(error?.details);
}
