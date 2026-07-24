// AI safety taxonomy event queries over the in-memory ring buffer.
import {
  ensureSafetyEventStoreBridge,
  getSafetyMetricsSummary,
  querySafetyEvents,
} from "../../infra/safety-event-store.js";
import type { GatewayRequestHandlers } from "./types.js";

// Capture emitted AI safety diagnostic events into the queryable ring buffer.
ensureSafetyEventStoreBridge();

const DEFAULT_SAFETY_LIMIT = 100;
const MAX_SAFETY_LIMIT = 500;

function parseSafetyLimit(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return DEFAULT_SAFETY_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return DEFAULT_SAFETY_LIMIT;
  }
  return Math.min(n, MAX_SAFETY_LIMIT);
}

function parseSafetyString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Gateway RPC handlers for the AI safety observability surface.
 *
 * safety.events.list — cursor-paginated list of stored SafetyEventRecord entries.
 * safety.events.summary — time-bucketed MetricBucket[] for the KPI time-series chart.
 */
export const safetyHandlers: GatewayRequestHandlers = {
  "safety.events.list": ({ params, respond }) => {
    const page = querySafetyEvents({
      cursor: parseSafetyString(params["cursor"]),
      limit: parseSafetyLimit(params["limit"]),
      eventType: parseSafetyString(params["eventType"]),
      severity: parseSafetyString(params["severity"]),
      sessionId: parseSafetyString(params["sessionId"]),
      channel: parseSafetyString(params["channel"]),
    });
    respond(true, page);
  },

  "safety.events.summary": ({ params, respond }) => {
    const now = Date.now();
    const toMs =
      typeof params["toMs"] === "number" && Number.isFinite(params["toMs"]) ? params["toMs"] : now;
    const fromMs =
      typeof params["fromMs"] === "number" && Number.isFinite(params["fromMs"])
        ? params["fromMs"]
        : now - 60 * 60 * 1000; // default: last hour
    const bucketSeconds =
      typeof params["bucketSeconds"] === "number" &&
      Number.isFinite(params["bucketSeconds"]) &&
      params["bucketSeconds"] > 0
        ? params["bucketSeconds"]
        : 300; // default: 5-minute buckets

    const result = getSafetyMetricsSummary({ fromMs, toMs, bucketSeconds });
    respond(true, result);
  },
};
