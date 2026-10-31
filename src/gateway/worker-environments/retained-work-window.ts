import type { WorkerEnvironmentRetention } from "../../plugins/worker-retention.types.js";

/** Live execution check; the durable operation and provider window never renew on activity. */
export function isWorkerRetainedWindowOpen(
  environment: { retention?: WorkerEnvironmentRetention | null } | undefined,
  nowMs = Date.now(),
): boolean {
  const retained = environment?.retention;
  return (
    !retained ||
    (retained.runtimeReady &&
      !retained.operation &&
      retained.observation?.state === "running" &&
      retained.observation.computeExpiresAtMs > nowMs)
  );
}
