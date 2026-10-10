import type { Socket } from "node:net";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { WebSocket } from "ws";
import { truncateUtf16Safe } from "../../utils.js";

const LOG_HEADER_MAX_LEN = 300;

export function stringMetaValue(meta: Record<string, unknown>, key: string): string | undefined {
  return readNonBlankString(meta[key]);
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
  const error = asOptionalObjectRecord(err);
  if (error?.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    return true;
  }
  const message = error?.message;
  return typeof message === "string" && /max payload size exceeded/i.test(message);
}
