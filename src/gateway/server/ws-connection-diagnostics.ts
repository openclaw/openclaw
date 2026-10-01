import type { Socket } from "node:net";
import type { WebSocket } from "ws";
import { truncateUtf16Safe } from "../../utils.js";

const LOG_HEADER_MAX_LEN = 300;

export function stringMetaValue(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function sanitizeWsLogValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }
  return truncateUtf16Safe(cleaned, LOG_HEADER_MAX_LEN);
}

function formatSocketEndpoint(
  address: string | undefined,
  port: number | undefined,
): string | undefined {
  if (!address) {
    return undefined;
  }
  if (port === undefined) {
    return address;
  }
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

export function resolveSocketAddress(socket: WebSocket): {
  remoteAddr?: string;
  remotePort?: number;
  localAddr?: string;
  localPort?: number;
  endpoint?: string;
} {
  const rawSocket = (socket as WebSocket & { _socket?: Socket })["_socket"];
  const remoteAddr = rawSocket?.remoteAddress;
  const remotePort = rawSocket?.remotePort;
  const localAddr = rawSocket?.localAddress;
  const localPort = rawSocket?.localPort;
  const remoteEndpoint = formatSocketEndpoint(remoteAddr, remotePort);
  const localEndpoint = formatSocketEndpoint(localAddr, localPort);
  return {
    remoteAddr,
    remotePort,
    localAddr,
    localPort,
    endpoint:
      remoteEndpoint && localEndpoint
        ? `${remoteEndpoint}->${localEndpoint}`
        : (remoteEndpoint ?? localEndpoint),
  };
}

export function isWsPayloadLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /max payload size exceeded/i.test(message);
}
