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
import type {
  GatewayWsPresenceMode,
  GatewayWsSessionEventAttribution,
} from "../../infra/diagnostic-rpc-types.js";
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
type EventCounter = {
  event: string;
  count: number;
  bytes: number;
  wireBytes: number | undefined;
  buckets: Float64Array;
  pending: boolean;
  sessionEvent?: GatewayWsSessionEventAttribution;
  presenceMode?: GatewayWsPresenceMode;
};
// Event names and session reasons are bounded by their protocol/attribution owners.
const eventCounters = new Map<
  string,
  Map<string | undefined, Map<string | undefined, EventCounter>>
>();
const pendingCounters: EventCounter[] = [];
const FRAME_BYTE_BOUNDS = [256, 512, 1024, 2048, 4096, 8192, 16384, 65536, Infinity];
const FRAME_BYTE_LABELS = FRAME_BYTE_BOUNDS.map((bound) =>
  bound === Infinity ? "+Inf" : String(bound),
);

function flushEventCounters() {
  for (const counter of pendingCounters) {
    let frameBytes: EventTraffic["frameBytes"];
    if (counter.count > 0) {
      frameBytes = {};
      let cumulative = 0;
      for (let i = 0; i < FRAME_BYTE_LABELS.length; i++) {
        cumulative += counter.buckets[i]!;
        frameBytes[FRAME_BYTE_LABELS[i]!] = cumulative;
      }
    }
    // The dispatcher queues these events: publish a snapshot, never the reusable counters.
    emitTrustedDiagnosticEvent({
      type: "gateway.ws.event",
      event: counter.event,
      count: counter.count,
      bytes: counter.bytes,
      ...(counter.wireBytes !== undefined ? { wireBytes: counter.wireBytes } : {}),
      ...(counter.sessionEvent ? { sessionEvent: counter.sessionEvent } : {}),
      ...(counter.presenceMode ? { presenceMode: counter.presenceMode } : {}),
      ...(frameBytes ? { frameBytes } : {}),
    });
    counter.count = counter.bytes = 0;
    counter.wireBytes = undefined;
    counter.buckets.fill(0);
    counter.pending = false;
  }
  pendingCounters.length = 0;
}

export function recordGatewayWsEvent(
  event: string,
  bytes: number,
  sessionEvent?: GatewayWsSessionEventAttribution,
  presenceMode?: GatewayWsPresenceMode,
  wireBytes?: number,
): boolean {
  if (
    !areDiagnosticsEnabledForProcess() ||
    !hasInternalDiagnosticEventInterest("gateway.ws.event", true)
  ) {
    return false;
  }
  const name = gatewayEventNames.has(event) ? event : "other";
  let reasons = eventCounters.get(name);
  if (!reasons) {
    eventCounters.set(name, (reasons = new Map()));
  }
  let deliveries = reasons.get(sessionEvent?.reason);
  if (!deliveries) {
    reasons.set(sessionEvent?.reason, (deliveries = new Map()));
  }
  const delivery = sessionEvent?.delivery ?? presenceMode;
  let counter = deliveries.get(delivery);
  if (!counter) {
    counter = {
      event: name,
      count: 0,
      bytes: 0,
      wireBytes: undefined,
      buckets: new Float64Array(FRAME_BYTE_BOUNDS.length),
      pending: false,
    };
    deliveries.set(delivery, counter);
  }
  if (!counter.pending) {
    if (pendingCounters.length === 0) {
      runInDetachedAsyncContext(() => setImmediate(flushEventCounters).unref());
    }
    counter.pending = true;
    counter.sessionEvent = sessionEvent;
    counter.presenceMode = presenceMode;
    pendingCounters.push(counter);
  }
  counter.bytes += bytes;
  if (wireBytes !== undefined) {
    counter.wireBytes = (counter.wireBytes ?? 0) + wireBytes;
  } else {
    counter.count++;
    // Count one exclusive bucket; cumulative exporter buckets are built only at flush.
    for (let i = 0; i < FRAME_BYTE_BOUNDS.length; i++) {
      if (bytes <= FRAME_BYTE_BOUNDS[i]!) {
        counter.buckets[i] = counter.buckets[i]! + 1;
        break;
      }
    }
  }
  return true;
}
