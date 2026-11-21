import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "../../infra/diagnostic-events.js";

type CollaborationPhase =
  | `session.members.${"list" | "listEvidence"}.${"profiles" | "evidence" | "projection"}`
  | `session.discussion.${"info" | "open"}.provider`;

/** Attribute worker and provider waits without collecting session or response data. */
export async function measureSessionCollaborationPhase<T>(
  name: CollaborationPhase,
  run: () => Promise<T>,
): Promise<T> {
  const emit = createQueuedDiagnosticPhaseEmitter();
  if (!emit) {
    return run();
  }
  const startedAt = Date.now();
  const started = performance.now();
  try {
    return await run();
  } finally {
    try {
      emit({ name, startedAt, endedAt: Date.now(), durationMs: performance.now() - started });
    } catch {
      // Diagnostics must preserve the original result or failure.
    }
  }
}
