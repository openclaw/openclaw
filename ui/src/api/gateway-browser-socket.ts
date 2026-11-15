import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  type ErrorShape,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";
import { hasEmbedderTransport } from "../app/remote-ingress.ts";
import { gatewayWebSocketTransportUrl, uiDevGatewayResourceUrl } from "../dev-gateway.ts";
import { t } from "../i18n/index.ts";
import { formatConnectionErrorSummary } from "../lib/connection-error.ts";
import { listen } from "../lib/reactive/listener.ts";

declare global {
  /**
   * Transport installed by an embedding loader (the OpenClaw ID claw loader's
   * /_loader/inject.js). It returns a WebSocket-compatible socket for Gateway
   * URLs it carries over its tunnel, or undefined to use the browser WebSocket.
   */
  interface Window {
    ["__openclawTransport"]?: { createWebSocket(url: string): WebSocket | undefined };
  }
}

const BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE = "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR";
export const BROWSER_WEBSOCKET_SECURITY_ERROR_CODE = "BROWSER_WEBSOCKET_SECURITY_ERROR";

export function formatBrowserWebSocketConstructorError(err: unknown, url: string): ErrorShape {
  const name = err && typeof err === "object" && "name" in err ? err.name : undefined;
  const browserErrorName = typeof name === "string" && name.trim() ? name : undefined;
  const browserMessage = formatConnectionErrorSummary(err);
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
      ? t(isPlaintextWs ? "runtimeErrors.socketInsecure" : "runtimeErrors.socketRefused")
      : t("runtimeErrors.socketCreateFailed", { message: browserMessage }),
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
      headers: { "X-OpenClaw-Reachability-Probe": "1" },
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
): GatewayProtocolSocket {
  const transportUrl = gatewayWebSocketTransportUrl(url);
  const socket =
    (hasEmbedderTransport()
      ? window["__openclawTransport"]?.createWebSocket(transportUrl)
      : undefined) ?? new WebSocket(transportUrl);
  const listeners = new AbortController();
  const listenerOptions = { signal: listeners.signal };
  let opening = true;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  const finishOpening = () => {
    opening = false;
    if (openingTimer !== undefined) {
      clearTimeout(openingTimer);
      openingTimer = undefined;
    }
  };
  const finishClose = (code: number, reason: string) => {
    if (listeners.signal.aborted) {
      return;
    }
    finishOpening();
    // The protocol owner can reconnect synchronously from this terminal callback.
    listeners.abort();
    handlers.close(code, reason);
  };

  listen(
    socket,
    "open",
    () => {
      finishOpening();
      handlers.open();
    },
    listenerOptions,
  );
  listen(socket, "message", (event) => handlers.message(String(event.data ?? "")), listenerOptions);
  listen(socket, "close", (event) => finishClose(event.code, event.reason), listenerOptions);
  listen(
    socket,
    "error",
    () => {
      finishOpening();
      handlers.error(new Error("websocket error"));
    },
    listenerOptions,
  );

  // The protocol challenge timer starts after `open`. Bound the browser's
  // opening phase to the same default preauth budget used by the Node client.
  openingTimer = setTimeout(() => {
    openingTimer = undefined;
    if (!opening) {
      return;
    }
    opening = false;
    const reason = t("runtimeErrors.socketTimeout", {
      milliseconds: String(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS),
    });
    try {
      handlers.error(new Error(reason));
    } finally {
      socket.close();
      finishClose(1006, reason);
    }
  }, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

  return {
    isOpen: () => !listeners.signal.aborted && socket.readyState === WebSocket.OPEN,
    send: (data) => socket.send(data),
    close: (code, reason) => {
      if (listeners.signal.aborted) {
        return;
      }
      finishOpening();
      // Browser-initiated closes reject the shared protocol's 1008 policy code.
      socket.close(code === 1008 ? 4008 : code, reason);
      // A dead peer may never finish the native closing handshake. Retire locally,
      // preserving the owner's code rather than the browser-only wire translation.
      finishClose(code ?? 1000, reason ?? "");
    },
  };
}
