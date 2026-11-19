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
import {
  hasGatewayWsMetricsListeners,
  publishGatewayWsMetrics,
} from "../../infra/gateway-ws-metrics.js";
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

export function resolveSocketAddress(socket: WebSocket) {
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
  traffic: EventTraffic;
  buckets: Float64Array;
  pending: boolean;
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
    const { traffic } = counter;
    publishGatewayWsMetrics(
      traffic.event,
      traffic.count,
      traffic.bytes,
      traffic.wireBytes,
      counter.buckets,
      FRAME_BYTE_LABELS,
      traffic.sessionEvent,
      traffic.presenceMode,
    );
    if (hasInternalDiagnosticEventInterest("gateway.ws.event", true)) {
      if (traffic.count > 0) {
        const frameBytes: NonNullable<EventTraffic["frameBytes"]> = {};
        let cumulative = traffic.count;
        // Start with the largest index so V8 never grows a mostly empty elements array.
        for (let i = FRAME_BYTE_LABELS.length - 1; i >= 0; i--) {
          frameBytes[FRAME_BYTE_LABELS[i]!] = cumulative;
          cumulative -= counter.buckets[i]!;
        }
        // Explicit subscribers retain detached snapshots; exporters borrow the counters above.
        traffic.frameBytes = Object.freeze(frameBytes);
      }
      emitTrustedDiagnosticEvent(traffic);
    }
    traffic.count = traffic.bytes = 0;
    traffic.wireBytes = traffic.frameBytes = undefined;
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
    (!hasGatewayWsMetricsListeners() &&
      !hasInternalDiagnosticEventInterest("gateway.ws.event", true))
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
      traffic: {
        type: "gateway.ws.event",
        event: name,
        count: 0,
        bytes: 0,
        sessionEvent: sessionEvent && Object.freeze({ ...sessionEvent }),
        presenceMode,
      },
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
    pendingCounters.push(counter);
  }
  counter.traffic.bytes += bytes;
  if (wireBytes !== undefined) {
    counter.traffic.wireBytes = (counter.traffic.wireBytes ?? 0) + wireBytes;
  } else {
    counter.traffic.count++;
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
