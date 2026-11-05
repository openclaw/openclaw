import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("gateway/worker-provisioning");

/** Timing never changes provisioning's result, cancellation, or cleanup. */
export async function measureProjectProvisionPhase<T>(
  phase: "project.prepare" | "project.snapshot",
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let outcome: "success" | "failed" = "failed";
  try {
    const result = await run();
    outcome = "success";
    return result;
  } finally {
    try {
      log.info("Worker project phase", { phase, durationMs: performance.now() - started, outcome });
    } catch {
      /* Diagnostics do not own provisioning. */
    }
  }
}
