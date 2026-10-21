import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "../infra/diagnostic-events.js";
import { createPhaseTimings } from "./server-methods/phase-timings.js";

type DocumentStage =
  | "auth_grants"
  | "identity_avatar"
  | "plugin_catalog"
  | "git_branch"
  | "preferences"
  | "render";

/** Emit after delivery; parallel preparation stages overlap within the total. */
export function startControlUiDocumentDiagnostics(startedAt: number) {
  const emit = createQueuedDiagnosticPhaseEmitter();
  if (!emit) {
    return undefined;
  }
  const timing = createPhaseTimings<DocumentStage>();
  return {
    scope: timing.scope,
    [Symbol.dispose]() {
      const durationMs = performance.now() - startedAt;
      const endedAt = Date.now();
      timing.flush(performance.now());
      timing.close();
      for (const [stage, elapsed] of [...timing.totals, ["total", durationMs] as const]) {
        emit({
          name: `control-ui.document.${stage}`,
          startedAt: endedAt - elapsed,
          endedAt,
          durationMs: elapsed,
        });
      }
    },
  };
}

export type ControlUiDocumentDiagnostics = ReturnType<typeof startControlUiDocumentDiagnostics>;
