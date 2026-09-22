import {
  createChannelIngressMonitor,
  type CreateChannelIngressMonitorOptions,
} from "./ingress-monitor.js";

export type RawEvent = { id: string; lane: string; text: string };
export type StoredEvent = { version: 1; rawEvent: string };
type MonitorOptions = CreateChannelIngressMonitorOptions<RawEvent, string, StoredEvent, unknown>;

export class PermanentIngressError extends Error {}

export function createMonitor(
  queue: MonitorOptions["queue"],
  deliver: MonitorOptions["deliver"],
  activityOrMonitorOptions?:
    | MonitorOptions["onActivityChange"]
    | (Partial<Omit<MonitorOptions, "queue" | "deliver" | "payload" | "drain">> &
        Pick<NonNullable<MonitorOptions["drain"]>, "retryPolicy" | "deferredLaneOccupancy">),
  onError?: (error: unknown) => void,
  abortSignal?: AbortSignal,
  pollIntervalMs = 10,
  retryBaseMs = 1_000,
) {
  const onActivityChange =
    typeof activityOrMonitorOptions === "function" ? activityOrMonitorOptions : undefined;
  const monitorOptions =
    typeof activityOrMonitorOptions === "object" ? activityOrMonitorOptions : {};
  const { inspect, retryPolicy, deferredLaneOccupancy, ...baseMonitorOptions } = monitorOptions;
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: inspect ?? ((raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` })),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new PermanentIngressError(kind),
    },
    deliver,
    pollIntervalMs,
    retention: { pruneIntervalMs: 60_000 },
    ...baseMonitorOptions,
    drain: {
      adoptionStallTimeoutMs: 5_000,
      retryPolicy: retryPolicy ?? { baseMs: retryBaseMs, maxMs: retryBaseMs },
      ...(deferredLaneOccupancy ? { deferredLaneOccupancy } : {}),
      resolveNonRetryableFailure: (error) =>
        error instanceof PermanentIngressError
          ? { reason: "invalid-event", message: error.message }
          : null,
    },
    ...(onActivityChange ? { onActivityChange } : {}),
    ...(onError ? { onError } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  });
}
