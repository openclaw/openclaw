import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

type UiE2ePhase =
  | "suite-setup"
  | "suite-cleanup"
  | "context-setup"
  | "context-cleanup"
  | "test-callback"
  | "scenario-cleanup"
  | "gateway-start-queue"
  | "gateway-start"
  | "gateway-readiness"
  | "gateway-stop"
  | "gateway-cleanup"
  | "fresh-visit-state-import"
  | "fresh-visit-state-create"
  | "fresh-visit-harness-import"
  | "fresh-visit-ready"
  | "source-server-imports"
  | "source-server-port"
  | "source-server-create"
  | "source-server-listen";

const noTiming = () => {};

/** Completed worker-local intervals; nested phases must not be summed.
 * Optional setup starts also identify an operation that never settles.
 */
export function beginUiE2ePhase(phase: UiE2ePhase | undefined, recordStart = false): () => void {
  if (!phase || !process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim()) {
    return noTiming;
  }
  const startMs = performance.timeOrigin + performance.now();
  if (recordStart) {
    try {
      writeSync(
        2,
        `[control-ui-e2e-setup-start] ${JSON.stringify({ phase, pid: process.pid, startMs })}\n`,
      );
    } catch {
      // A failed checkpoint must not prevent the owner from starting.
    }
  }
  return () => {
    const endMs = performance.timeOrigin + performance.now();
    try {
      writeSync(
        2,
        `[control-ui-e2e-phase] ${JSON.stringify({ phase, pid: process.pid, startMs, endMs })}\n`,
      );
    } catch {
      // Diagnostics must preserve the operation's result, including cleanup failures.
    }
  };
}
