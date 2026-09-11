const APPLE_REFERENCE_DATE_SECONDS = 978_307_200;
// Remote freshness belongs to the original fact, not a retry or token rotation.
const REMOTE_ACTIVITY_STALE_SECONDS = 240;
const MAX_PAYLOAD_BYTES = 2_048;
const preparedPayload = Symbol("apns.live-activity.payload");
const statuses = {
  running: "running",
  toolRunning: "toolRunning",
  approvalNeeded: "approvalNeeded",
  done: "completed",
  failed: "failed",
  killed: "cancelled",
  timeout: "timedOut",
} as const;

type RunActivityContentState = Readonly<{
  status: (typeof statuses)[keyof typeof statuses];
  observedAt: number;
  startedAt?: number;
  endedAt?: number;
}>;

/** Only the builder can prepare the bounded, immutable bytes used by both transports. */
export type ApnsLiveActivityPayload = Readonly<{
  [preparedPayload]: true;
  value: Readonly<{
    aps: Readonly<{
      timestamp: number;
      event: "update" | "end";
      "content-state": RunActivityContentState;
      "stale-date": number;
      "relevance-score": 10;
    }>;
  }>;
  json: string;
  priority: "5" | "10";
}>;

function requireUnixMilliseconds(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid Live Activity fact date");
  }
}

/** Projects recorded run facts into OpenClawRunActivityAttributes.ContentState. */
export function createApnsLiveActivityPayload(params: {
  snapshot: Readonly<{
    status: keyof typeof statuses;
    observedAtMs: number;
    startedAtMs?: number;
    endedAtMs?: number;
  }>;
  timestamp: number;
}): ApnsLiveActivityPayload {
  const { timestamp, snapshot } = params;
  const { status, observedAtMs, startedAtMs } = snapshot;
  const endedAtMs = "endedAtMs" in snapshot ? snapshot.endedAtMs : undefined;
  if (!Object.hasOwn(statuses, status)) {
    throw new Error("Invalid Live Activity status");
  }
  requireUnixMilliseconds(observedAtMs);
  if (startedAtMs !== undefined) {
    requireUnixMilliseconds(startedAtMs);
  }
  if (endedAtMs !== undefined) {
    requireUnixMilliseconds(endedAtMs);
  }
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < Math.floor(observedAtMs / 1_000) ||
    timestamp > Math.floor(Number.MAX_SAFE_INTEGER / 1_000) ||
    (startedAtMs !== undefined && startedAtMs > observedAtMs) ||
    (endedAtMs !== undefined &&
      (endedAtMs > observedAtMs || (startedAtMs !== undefined && endedAtMs < startedAtMs)))
  ) {
    throw new Error("Invalid Live Activity date ordering");
  }
  const terminal = status !== "running" && status !== "toolRunning" && status !== "approvalNeeded";
  if (!terminal && endedAtMs !== undefined) {
    throw new Error("An active Live Activity cannot have an end date");
  }
  // Swift's default Date codec uses the 2001 reference date; APNs envelope dates use Unix time.
  const contentState: RunActivityContentState = Object.freeze({
    status: statuses[status],
    observedAt: observedAtMs / 1_000 - APPLE_REFERENCE_DATE_SECONDS,
    ...(startedAtMs !== undefined
      ? { startedAt: startedAtMs / 1_000 - APPLE_REFERENCE_DATE_SECONDS }
      : {}),
    ...(endedAtMs !== undefined
      ? { endedAt: endedAtMs / 1_000 - APPLE_REFERENCE_DATE_SECONDS }
      : {}),
  });
  const value: ApnsLiveActivityPayload["value"] = Object.freeze({
    aps: Object.freeze({
      timestamp,
      event: terminal ? "end" : "update",
      "content-state": contentState,
      "stale-date": Math.floor(observedAtMs / 1_000) + REMOTE_ACTIVITY_STALE_SECONDS,
      "relevance-score": 10,
    }),
  });
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Live Activity payload exceeds 2048 bytes");
  }
  return Object.freeze<ApnsLiveActivityPayload>({
    [preparedPayload]: true,
    value,
    json,
    priority: terminal ? "10" : "5",
  });
}
