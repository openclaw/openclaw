import { expect, it } from "vitest";
import {
  createUpdateStateInspectionDiagnostics,
  UPDATE_STATE_INSPECTION_PROGRESS_PREFIX,
} from "./update-candidate-state.diagnostics.js";

it.each(["SIGILL", "SIGABRT", "SIGTERM"])(
  "reports the active worker step for %s without blaming storage",
  (signal) => {
    const source = "/synthetic/operator/state/agents/main/agent/openclaw-agent.sqlite";
    const diagnostics = createUpdateStateInspectionDiagnostics({
      operation: "State schema inspection",
      phase: "pre-migration database backup",
      paths: [source],
    });
    const phase = "loading sqlite-vec for source validation";
    diagnostics.onOutputChunk(
      Buffer.from(
        UPDATE_STATE_INSPECTION_PROGRESS_PREFIX + JSON.stringify({ phase, path: source }) + "\n",
      ),
      "stderr",
    );
    const message = diagnostics.failure(undefined, "signal, signal " + signal).message;
    expect(message).toContain(signal);
    expect(message).toContain("during " + phase + " for " + source);
    expect(message).toContain("terminated by a signal");
    expect(message).not.toMatch(/Check access|free space|storage performance/);
  },
);
