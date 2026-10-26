// Native hints remain immediate; this pass recovers missed events without frequent idle wakeups.
export const FS_RECONCILE_MS = 5 * 60_000;

/** Preserve operator polling overrides while letting fs-safe choose the native backend. */
export function resolveFsObservationMode(env: NodeJS.ProcessEnv = process.env): "auto" | "poll" {
  const value = env.CHOKIDAR_USEPOLLING?.toLowerCase();
  return value && value !== "false" && value !== "0" ? "poll" : "auto";
}

export function resolveFsObservationIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
  defaultIntervalMs = 100,
): number {
  const interval = Number.parseInt(env.CHOKIDAR_INTERVAL ?? "", 10);
  return Number.isFinite(interval) && interval > 0
    ? Math.min(2_147_483_647, Math.max(20, interval))
    : defaultIntervalMs;
}
