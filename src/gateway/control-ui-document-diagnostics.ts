import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "../infra/diagnostic-events.js";

type DocumentStage =
  | "auth_grants"
  | "identity_avatar"
  | "plugin_catalog"
  | "git_branch"
  | "preferences"
  | "render";
type DocumentPhase = { name: string; startedAt: number; endedAt?: number };

/** Emit after delivery; parallel preparation stages overlap within the total. */
export function startControlUiDocumentDiagnostics(startedAt: number) {
  const emit = createQueuedDiagnosticPhaseEmitter();
  if (!emit) {
    return undefined;
  }
  const phases: DocumentPhase[] = [];
  return {
    scope(stage: DocumentStage) {
      const phase: DocumentPhase = {
        name: `control-ui.document.${stage}`,
        startedAt: performance.now(),
      };
      phases.push(phase);
      return {
        [Symbol.dispose]() {
          phase.endedAt ??= performance.now();
        },
      };
    },
    [Symbol.dispose]() {
      const endedAt = performance.now();
      phases.push({ name: "control-ui.document.total", startedAt, endedAt });
      for (const phase of phases) {
        const end = phase.endedAt ?? endedAt;
        emit({
          name: phase.name,
          startedAt: performance.timeOrigin + phase.startedAt,
          endedAt: performance.timeOrigin + end,
          durationMs: end - phase.startedAt,
        });
      }
    },
  };
}

export type ControlUiDocumentDiagnostics = ReturnType<typeof startControlUiDocumentDiagnostics>;
