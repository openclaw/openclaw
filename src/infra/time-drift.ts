export interface TimeDriftCheckResult {
  /** Estimated drift in milliseconds (positive = local clock ahead). */
  driftMs: number;
  /** Absolute drift value. */
  absDriftMs: number;
  /** Whether drift exceeds the configured threshold. */
  exceeds: boolean;
  /** The source URL that was queried. */
  source: string;
  /** The threshold used for the check (ms). */
  thresholdMs: number;
}

export interface CheckTimeDriftOpts {
  /** URL to HTTP HEAD for the `Date` header. */
  source?: string;
  /** Maximum acceptable drift in seconds. */
  thresholdSeconds?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_SOURCE = "https://www.google.com";
const DEFAULT_THRESHOLD_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Measures local clock drift by comparing `Date.now()` against the `Date`
 * header returned by an HTTP HEAD request.  Uses the midpoint of the request
 * window to reduce RTT bias.
 */
export async function checkTimeDrift(opts?: CheckTimeDriftOpts): Promise<TimeDriftCheckResult> {
  const source = opts?.source?.trim() || DEFAULT_SOURCE;
  const thresholdMs = (opts?.thresholdSeconds ?? DEFAULT_THRESHOLD_SECONDS) * 1_000;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const before = Date.now();
  const res = await fetch(source, {
    method: "HEAD",
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  const after = Date.now();

  const dateHeader = res.headers.get("date");
  if (!dateHeader) {
    throw new Error(`time-drift: no Date header from ${source}`);
  }

  const remoteMs = new Date(dateHeader).getTime();
  if (!Number.isFinite(remoteMs)) {
    throw new Error(`time-drift: unparseable Date header: ${dateHeader}`);
  }

  // Midpoint of the request window approximates when the server generated the
  // Date header, reducing network round-trip bias.
  const localMidpoint = (before + after) / 2;
  const driftMs = localMidpoint - remoteMs;
  const absDriftMs = Math.abs(driftMs);

  return {
    driftMs,
    absDriftMs,
    exceeds: absDriftMs > thresholdMs,
    source,
    thresholdMs,
  };
}

/** Human-readable one-liner describing drift. */
export function formatDriftForLog(result: TimeDriftCheckResult): string {
  const seconds = (result.driftMs / 1_000).toFixed(1);
  const direction = result.driftMs >= 0 ? "ahead" : "behind";
  const threshold = (result.thresholdMs / 1_000).toFixed(0);
  if (result.exceeds) {
    return `clock is ${seconds}s ${direction} of ${result.source} (threshold: ${threshold}s)`;
  }
  return `clock within tolerance (${seconds}s ${direction}, threshold: ${threshold}s)`;
}
