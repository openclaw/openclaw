/** Preserve operator polling overrides while letting fs-safe choose the native backend. */
export function resolveFsObservationMode(
  env: NodeJS.ProcessEnv = process.env,
): "auto" | "events" | "poll" {
  const value = env.CHOKIDAR_USEPOLLING?.toLowerCase();
  if (value === undefined) {
    return "auto";
  }
  return value && value !== "false" && value !== "0" ? "poll" : "events";
}

export function resolveFsObservationIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const interval = Number.parseInt(env.CHOKIDAR_INTERVAL ?? "", 10);
  return Number.isFinite(interval) && interval > 0
    ? Math.min(2_147_483_647, Math.max(20, interval))
    : 100;
}
