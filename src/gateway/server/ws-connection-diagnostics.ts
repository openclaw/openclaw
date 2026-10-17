import type { Socket } from "node:net";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { WebSocket } from "ws";
import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
  type DiagnosticEventInput,
} from "../../infra/diagnostic-events.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { truncateUtf16Safe } from "../../utils.js";
import { GATEWAY_EVENTS } from "../events.js";

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

const gatewayEventNames = new Set(GATEWAY_EVENTS);
type EventTraffic = Extract<DiagnosticEventInput, { type: "gateway.ws.event" }>;
let pendingEventTraffic: Map<string, EventTraffic> | undefined;

export function recordGatewayWsEvent(event: string, bytes: number): void {
  if (
    !areDiagnosticsEnabledForProcess() ||
    !hasInternalDiagnosticEventInterest("gateway.ws.event", true)
  ) {
    return;
  }
  // Bound storage to the protocol catalog and publish once per event-loop turn,
  // so fanout counts every socket without queueing a diagnostic per frame.
  const name = gatewayEventNames.has(event) ? event : "other";
  if (!pendingEventTraffic) {
    pendingEventTraffic = new Map();
    runInDetachedAsyncContext(() =>
      setImmediate(() => {
        const batch = pendingEventTraffic!;
        pendingEventTraffic = undefined;
        for (const observation of batch.values()) {
          emitTrustedDiagnosticEvent(observation);
        }
      }).unref(),
    );
  }
  const observation = pendingEventTraffic.get(name);
  if (observation) {
    observation.count++;
    observation.bytes += bytes;
  } else {
    pendingEventTraffic.set(name, { type: "gateway.ws.event", event: name, count: 1, bytes });
  }
}
