const DEFAULT_MAX_STORES = 64;
const DEFAULT_STORE_RETAIN_LIMIT = 64;
const DEFAULT_STORE_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_STORE_IDLE_SWEEP_MS = 60_000;

/** The store cap is a deployment knob: burst concurrency can raise it without a rebuild. */
export function resolveSqliteWorkerStoreCap(): number {
  const raw = process.env.OPENCLAW_SQLITE_WORKER_MAX_STORES?.trim();
  if (!raw) {
    return DEFAULT_MAX_STORES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MAX_STORES;
  }
  return Math.min(parsed, 4096);
}

/** Live clients kept before idle clients are retired; bounds the retained floor. */
export function resolveSqliteWorkerStoreRetainLimit(): number {
  const raw = process.env.OPENCLAW_SQLITE_WORKER_STORE_RETAIN_LIMIT?.trim();
  if (!raw) {
    return DEFAULT_STORE_RETAIN_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_STORE_RETAIN_LIMIT;
  }
  return Math.min(parsed, 4096);
}

/** Idle age before a store client may release its retained state. */
export function resolveSqliteWorkerStoreIdleTtlMs(): number {
  const raw = process.env.OPENCLAW_SQLITE_WORKER_STORE_IDLE_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_STORE_IDLE_TTL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STORE_IDLE_TTL_MS;
  }
  return Math.min(parsed, 86_400_000);
}

/** How often the broker sweeps for idle store clients. */
export function resolveSqliteWorkerStoreIdleSweepMs(): number {
  const raw = process.env.OPENCLAW_SQLITE_WORKER_STORE_IDLE_SWEEP_MS?.trim();
  if (!raw) {
    return DEFAULT_STORE_IDLE_SWEEP_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_STORE_IDLE_SWEEP_MS;
  }
  return Math.min(parsed, 3_600_000);
}
