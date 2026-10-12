import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  type ErrorShape,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";
import { gatewayWebSocketTransportUrl, uiDevGatewayResourceUrl } from "../dev-gateway.ts";
import { formatUiError } from "../lib/format-error.ts";

const BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE = "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR";
export const BROWSER_WEBSOCKET_SECURITY_ERROR_CODE = "BROWSER_WEBSOCKET_SECURITY_ERROR";

export function formatBrowserWebSocketConstructorError(err: unknown, url: string): ErrorShape {
  const name = err && typeof err === "object" && "name" in err ? err.name : undefined;
  const browserErrorName = typeof name === "string" && name.trim() ? name : undefined;
  const browserMessage = formatUiError(err);
  const message = browserMessage.toLowerCase();
  const securityError =
    browserErrorName?.toLowerCase() === "securityerror" ||
    message.includes("security error") ||
    message.includes("mixed content") ||
    message.includes("insecure websocket");
  const isPlaintextWs = url.trim().toLowerCase().startsWith("ws://");
  const code = securityError
    ? BROWSER_WEBSOCKET_SECURITY_ERROR_CODE
    : BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE;
  return {
    code,
    message: securityError
      ? "Browser refused the Gateway WebSocket for security reasons." +
        (isPlaintextWs
          ? " Use wss:// when the Control UI is served over HTTPS/Tailscale Serve, or open the loopback dashboard at http://127.0.0.1:18789."
          : " Check the Gateway WebSocket URL and browser security policy.")
      : `Could not create the Gateway WebSocket: ${browserMessage}`,
    details: { code, browserErrorName, browserMessage },
  };
}

export async function probeGatewayReachability(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const gateway = new URL(url, window.location.href);
    gateway.protocol = gateway.protocol.replace(/^ws/u, "http");
    const probe = new URL(
      uiDevGatewayResourceUrl(new URL("/healthz", gateway).href),
      window.location.href,
    );
    if (probe.origin !== new URL(window.location.href).origin) {
      return false;
    }
    const response = await fetch(probe, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      return false;
    }
    const body: unknown = await response.json();
    return (
      body !== null &&
      typeof body === "object" &&
      "ok" in body &&
      body.ok === true &&
      "status" in body &&
      body.status === "live"
    );
  } catch {
    return false;
  }
}

export function createBrowserGatewaySocket(
  url: string,
  handlers: GatewayProtocolSocketHandlers,
  maxPayloadBytes?: () => number | undefined,
): GatewayProtocolSocket {
  const socket = new WebSocket(gatewayWebSocketTransportUrl(url));
  let opening = true;
  let openingTimeoutReason: string | undefined;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  const finishOpening = () => {
    opening = false;
    if (openingTimer !== undefined) {
      clearTimeout(openingTimer);
      openingTimer = undefined;
    }
  };

  socket.addEventListener("open", () => {
    finishOpening();
    handlers.open();
  });
  socket.addEventListener("message", (event) => handlers.message(String(event.data ?? "")));
  socket.addEventListener("close", (event) => {
    finishOpening();
    // Browsers erase locally initiated close reasons before the handshake finishes.
    handlers.close(event.code, event.reason || openingTimeoutReason || "");
  });
  socket.addEventListener("error", () => {
    finishOpening();
    if (!openingTimeoutReason) {
      handlers.error(new Error("websocket error"));
    }
  });

  // The protocol challenge timer starts after `open`. Bound the browser's
  // opening phase to the same default preauth budget used by the Node client.
  openingTimer = setTimeout(() => {
    openingTimer = undefined;
    if (!opening) {
      return;
    }
    opening = false;
    openingTimeoutReason = `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`;
    try {
      handlers.error(new Error(openingTimeoutReason));
    } finally {
      socket.close();
    }
  }, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => {
      const limit = maxPayloadBytes?.();
      if (limit !== undefined && new TextEncoder().encode(data).byteLength > limit) {
        throw new GatewayPayloadLimitError();
      }
      socket.send(data);
    },
    close: (code, reason) => {
      finishOpening();
      // Browser-initiated closes reject the shared protocol's 1008 policy code.
      socket.close(code === 1008 ? 4008 : code, reason);
    },
  };
}

export class GatewayPayloadLimitError extends Error {
  constructor() {
    super(
      "Request exceeds the Gateway payload limit. Shorten the message or remove one or more attachments and retry.",
    );
    this.name = "GatewayPayloadLimitError";
  }
}
